package app

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/client-go/rest"
	"k8s.io/klog/v2"

	"github.com/grafana/grafana-app-sdk/app"
	"github.com/grafana/grafana-app-sdk/k8s"
	"github.com/grafana/grafana-app-sdk/operator"
	"github.com/grafana/grafana-app-sdk/resource"
	"github.com/grafana/grafana-app-sdk/simple"
	playlistv0alpha1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v0alpha1"
	playlistv1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
	"github.com/grafana/grafana/apps/playlist/pkg/reconcilers"
)

type PlaylistConfig struct {
	EnableReconcilers bool
}

// The playlist collection budget. It bounds how much work a single write can ask the server,
// the storage layer and every reader of the stored object to do, and it is the same contract in
// three places: the CUE schema apps/playlist/kinds/playlist.cue (the served OpenAPI limits),
// these constants (the enforced backend limits, shared by App SDK admission and the deprecated
// /api/playlists bridge) and public/app/features/playlist/variableLimits.ts (the editor and
// playback limits). All three copies change together; changing one alone lets a payload that
// one layer accepts be rejected -- or worse, be processed -- by another.
const (
	// MaxPlaylistItems bounds the number of items a single playlist write may carry.
	MaxPlaylistItems = 1000
	// MaxItemVariables bounds the number of distinct template variables one item may set.
	MaxItemVariables = 32
	// MaxVariableValues bounds the number of values one template variable may hold. Several
	// values under one name are how a multi-value variable is expressed.
	MaxVariableValues = 64
	// MaxVariableNameLength bounds the length of a template variable name in Unicode code
	// points, which is the unit the served schema's maxLength uses (the CUE constraint is
	// strings.MaxRunes) and therefore the unit this validator and the editor must use too: all
	// three then accept and reject exactly the same strings, whatever alphabet they are
	// written in. Counting bytes here instead would refuse a 128-character name of accented
	// letters that the published schema and the editor both accept.
	MaxVariableNameLength = 128
	// MaxVariableValueLength bounds the length of a single template variable value, also in
	// Unicode code points and for the same reason. A code point costs at most four UTF-8
	// bytes, so the byte cost of a full payload stays bounded by the request body limit the
	// API server applies before admission.
	MaxVariableValueLength = 1024
)

// ValidateItemCount checks a playlist's item count against MaxPlaylistItems and reports the
// violation under itemsPath, which lets each caller name the field as its own payload spells it
// (spec.items for a resource write, items for a legacy /api/playlists body).
//
// It is deliberately separate from ValidateItemVariables so a caller can reject an oversized
// item list before allocating or walking it: on the legacy path that ordering is what keeps a
// hostile body from being copied item by item before it is refused.
func ValidateItemCount(count int, itemsPath *field.Path) field.ErrorList {
	if count > MaxPlaylistItems {
		return field.ErrorList{field.TooMany(itemsPath, count, MaxPlaylistItems)}
	}
	return nil
}

// ValidateItemVariables validates one playlist item's template variables against the budget and
// against the one-or-more-values contract the served schema promises. variablesPath is the path
// of the variables field itself (for example spec.items[3].variables), so callers on different
// payload shapes produce error messages that match the document they were given.
//
// An absent or empty map is valid: variables are optional. Every other rule rejects a value that
// the served schema promises cannot occur -- a JSON null value decodes to a nil slice and a null
// array element decodes to an empty string, so both are caught here rather than persisted.
//
// Name and value lengths are counted in Unicode code points, the unit MaxVariableNameLength and
// MaxVariableValueLength are defined in.
//
// Errors are reported with field.TooMany and field.TooLongCharacters, which carry the limit and
// the observed quantity but never the offending string, and an over-long name is reported on the
// map path rather than keyed by that name: echoing an unbounded value back to the caller would
// make the error itself an amplification of the payload it rejects.
func ValidateItemVariables(variables map[string][]string, variablesPath *field.Path) field.ErrorList {
	if len(variables) == 0 {
		return nil
	}
	if len(variables) > MaxItemVariables {
		// Reported without walking the map: the point of the limit is to refuse a hostile
		// number of keys before doing per-key work.
		return field.ErrorList{field.TooMany(variablesPath, len(variables), MaxItemVariables)}
	}

	// Map iteration order is random, so the names are sorted to keep a multi-violation message
	// stable across runs. The slice is bounded by the key limit checked above.
	names := make([]string, 0, len(variables))
	for name := range variables {
		names = append(names, name)
	}
	sort.Strings(names)

	var errs field.ErrorList
	for _, name := range names {
		if name == "" {
			errs = append(errs, field.Required(variablesPath, "a template variable name is required"))
			continue
		}
		// utf8.RuneCountInString counts a byte that is not part of a valid encoding as one
		// code point, so a caller that hands admission a string it did not decode from JSON
		// is still bounded rather than able to slip past the limit.
		if utf8.RuneCountInString(name) > MaxVariableNameLength {
			errs = append(errs, field.TooLongCharacters(variablesPath, "", MaxVariableNameLength))
			continue
		}

		// Only a name that passed the length check above is keyed into a path, which keeps
		// every path below bounded by MaxVariableNameLength code points.
		valuesPath := variablesPath.Key(name)
		values := variables[name]
		if len(values) == 0 {
			errs = append(errs, field.Required(valuesPath,
				"a template variable requires at least one value"))
			continue
		}
		if len(values) > MaxVariableValues {
			errs = append(errs, field.TooMany(valuesPath, len(values), MaxVariableValues))
			continue
		}
		for i, value := range values {
			switch {
			case value == "":
				errs = append(errs, field.Required(valuesPath.Index(i),
					"a template variable value must not be empty"))
			case utf8.RuneCountInString(value) > MaxVariableValueLength:
				errs = append(errs, field.TooLongCharacters(valuesPath.Index(i), "", MaxVariableValueLength))
			}
		}
	}
	return errs
}

// playlistSpecItems is the projection of a playlist spec that admission validates. It mirrors the
// served schema for the fields it reads and ignores the rest, so it decodes any playlist spec
// shape the API server can hand to admission -- including an unstructured or untyped object,
// whose spec is a plain map.
type playlistSpecItems struct {
	Items []struct {
		Variables map[string][]string `json:"variables"`
	} `json:"items"`
}

// specItemVariables returns the variables map of every item of the given spec, in item order, so
// an error path can carry the item's index. The two generated spec types are handled directly;
// anything else is decoded through JSON, which is what keeps write paths that do not carry a
// typed object (an unstructured create, a patch applied to an untyped object) inside validation.
func specItemVariables(spec any) ([]map[string][]string, error) {
	switch typed := spec.(type) {
	case playlistv1.PlaylistSpec:
		return v1ItemVariables(typed.Items), nil
	case *playlistv1.PlaylistSpec:
		if typed == nil {
			return nil, nil
		}
		return v1ItemVariables(typed.Items), nil
	case playlistv0alpha1.PlaylistSpec:
		return v0alpha1ItemVariables(typed.Items), nil
	case *playlistv0alpha1.PlaylistSpec:
		if typed == nil {
			return nil, nil
		}
		return v0alpha1ItemVariables(typed.Items), nil
	case nil:
		return nil, nil
	}

	raw, err := json.Marshal(spec)
	if err != nil {
		return nil, fmt.Errorf("playlist spec could not be encoded for validation: %w", err)
	}
	decoded := playlistSpecItems{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("playlist spec does not match the playlist schema: %w", err)
	}
	items := make([]map[string][]string, len(decoded.Items))
	for i, item := range decoded.Items {
		items[i] = item.Variables
	}
	return items, nil
}

func v1ItemVariables(items []playlistv1.PlaylistItem) []map[string][]string {
	variables := make([]map[string][]string, len(items))
	for i, item := range items {
		variables[i] = item.Variables
	}
	return variables
}

func v0alpha1ItemVariables(items []playlistv0alpha1.PlaylistItem) []map[string][]string {
	variables := make([]map[string][]string, len(items))
	for i, item := range items {
		variables[i] = item.Variables
	}
	return variables
}

// validatePlaylistAdmission enforces the playlist collection budget and the variable value
// contract on every create and update admitted for either served version. One instance of this
// function backs both ManagedKinds entries, so v0alpha1 and v1 cannot drift apart.
//
// A request without an object (a delete, or a connect) has nothing to validate and is admitted.
// The returned error is a field.ErrorList aggregate; the App SDK wraps it in
// admission.NewForbidden, so the caller sees a 403 whose message must stand on its own -- hence
// the fully qualified field paths and the explicit limits.
func validatePlaylistAdmission(_ context.Context, req *app.AdmissionRequest) error {
	if req == nil || req.Object == nil {
		return nil
	}
	// A resource.Object held as a nil pointer is not caught by the interface comparison above,
	// and its generated GetSpec dereferences the receiver, so the two kinds this validator is
	// registered for are checked before the spec is read.
	switch obj := req.Object.(type) {
	case *playlistv1.Playlist:
		if obj == nil {
			return nil
		}
	case *playlistv0alpha1.Playlist:
		if obj == nil {
			return nil
		}
	}

	items, err := specItemVariables(req.Object.GetSpec())
	if err != nil {
		return err
	}

	itemsPath := field.NewPath("spec", "items")
	if errs := ValidateItemCount(len(items), itemsPath); len(errs) > 0 {
		// Returned before the per-item walk below, so an oversized list costs one comparison.
		return errs.ToAggregate()
	}

	var errs field.ErrorList
	for i, variables := range items {
		errs = append(errs, ValidateItemVariables(variables, itemsPath.Index(i).Child("variables"))...)
	}
	return errs.ToAggregate()
}

func getPatchClient(restConfig rest.Config, playlistKind resource.Kind) (operator.PatchClient, error) {
	clientGenerator := k8s.NewClientRegistry(restConfig, k8s.ClientConfig{})
	return clientGenerator.ClientFor(playlistKind)
}

func New(cfg app.Config) (app.App, error) {
	var (
		playlistReconciler operator.Reconciler
		err                error
	)

	playlistConfig, ok := cfg.SpecificConfig.(*PlaylistConfig)
	if ok && playlistConfig.EnableReconcilers {
		patchClient, err := getPatchClient(cfg.KubeConfig, playlistv0alpha1.PlaylistKind())
		if err != nil {
			klog.ErrorS(err, "Error getting patch client for use with opinionated reconciler")
			return nil, err
		}

		playlistReconciler, err = reconcilers.NewPlaylistReconciler(patchClient)
		if err != nil {
			klog.ErrorS(err, "Error creating playlist reconciler")
			return nil, err
		}
	}

	// shared for all versions
	playlistMutator := &simple.Mutator{
		MutateFunc: func(ctx context.Context, req *app.AdmissionRequest) (*app.MutatingResponse, error) {
			return &app.MutatingResponse{
				UpdatedObject: req.Object,
			}, nil
		},
	}

	// One validator instance for every version below: the budget and the variable value
	// contract are shared, so both versions enforce exactly the same rules.
	playlistValidator := &simple.Validator{
		ValidateFunc: validatePlaylistAdmission,
	}

	simpleConfig := simple.AppConfig{
		Name:       "playlist",
		KubeConfig: cfg.KubeConfig,
		InformerConfig: simple.AppInformerConfig{
			InformerOptions: operator.InformerOptions{
				ErrorHandler: func(ctx context.Context, err error) {
					klog.ErrorS(err, "Informer processing error")
				},
			},
		},
		ManagedKinds: []simple.AppManagedKind{
			{
				Kind:       playlistv0alpha1.PlaylistKind(),
				Reconciler: playlistReconciler,
				Mutator:    playlistMutator,
				Validator:  playlistValidator,
			},
			{
				Kind:       playlistv1.PlaylistKind(),
				Reconciler: playlistReconciler,
				Mutator:    playlistMutator,
				Validator:  playlistValidator,
			},
		},
		// Conversion for kinds is defined for all versions of a kind at once.
		// This interface may change in the future, see https://github.com/grafana/grafana-app-sdk/issues/617
		Converters: map[schema.GroupKind]simple.Converter{
			{
				Group: cfg.ManifestData.Group,
				Kind:  playlistv0alpha1.PlaylistKind().Kind(),
			}: NewExampleConverter(),
		},
	}

	a, err := simple.NewApp(simpleConfig)
	if err != nil {
		return nil, err
	}

	err = a.ValidateManifest(cfg.ManifestData)
	if err != nil {
		return nil, err
	}

	return a, nil
}

func GetKinds() map[schema.GroupVersion][]resource.Kind {
	gvV0alpha1 := schema.GroupVersion{
		Group:   playlistv0alpha1.PlaylistKind().Group(),
		Version: playlistv0alpha1.PlaylistKind().Version(),
	}
	gvV1 := schema.GroupVersion{
		Group:   playlistv1.PlaylistKind().Group(),
		Version: playlistv1.PlaylistKind().Version(),
	}
	return map[schema.GroupVersion][]resource.Kind{
		gvV0alpha1: {playlistv0alpha1.PlaylistKind()},
		gvV1:       {playlistv1.PlaylistKind()},
	}
}
