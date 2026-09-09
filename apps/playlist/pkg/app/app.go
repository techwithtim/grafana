package app

import (
	"context"
	"maps"
	"slices"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
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

// playlistItemTypes are the item types published in the `type` enum of the generated
// OpenAPI document, in the order the document lists them. Both served versions declare
// the same three values, so the v1 constants stand for both.
var playlistItemTypes = []playlistv1.PlaylistPlaylistItemType{
	playlistv1.PlaylistPlaylistItemTypeDashboardByTag,
	playlistv1.PlaylistPlaylistItemTypeDashboardByUid,
	playlistv1.PlaylistPlaylistItemTypeDashboardById,
}

// playlistGroupKind is the version-agnostic identity carried by the Invalid status of a
// rejected write.
var playlistGroupKind = schema.GroupKind{
	Group: playlistv1.APIGroup,
	Kind:  playlistv1.PlaylistKind().Kind(),
}

// playlistItem is the version-agnostic projection of one playlist item. The v1 and
// v0alpha1 item structs are structurally identical but distinct Go types, so each is
// normalised into this shape and a single rule set runs over it.
type playlistItem struct {
	itemType  string
	value     string
	variables map[string][]string
}

// playlistSubject is everything the item validation needs from an admitted object.
type playlistSubject struct {
	name  string
	items []playlistItem
}

// playlistSubjectFor projects a Playlist of either served version and reports false for
// anything else. The apiserver admission chain is shared with every other app installer,
// and a DELETE carries no object at all, so a non-Playlist argument is the common case
// and has to stay a cheap no-op.
func playlistSubjectFor(obj runtime.Object) (playlistSubject, bool) {
	switch typed := obj.(type) {
	case *playlistv1.Playlist:
		if typed == nil {
			return playlistSubject{}, false
		}
		items := make([]playlistItem, 0, len(typed.Spec.Items))
		for _, item := range typed.Spec.Items {
			items = append(items, playlistItem{
				itemType:  string(item.Type),
				value:     item.Value,
				variables: item.Variables,
			})
		}
		return playlistSubject{name: typed.GetName(), items: items}, true
	case *playlistv0alpha1.Playlist:
		if typed == nil {
			return playlistSubject{}, false
		}
		items := make([]playlistItem, 0, len(typed.Spec.Items))
		for _, item := range typed.Spec.Items {
			items = append(items, playlistItem{
				itemType:  string(item.Type),
				value:     item.Value,
				variables: item.Variables,
			})
		}
		return playlistSubject{name: typed.GetName(), items: items}, true
	default:
		return playlistSubject{}, false
	}
}

// ValidatePlaylistObject reports every way obj departs from the playlist item contract the
// generated OpenAPI document publishes for both served versions: `required: [type, value]`,
// the three-value `type` enum, and `variables` as a map of names to lists of strings. Only
// that structural contract is enforced here -- variable names and values are never checked
// against the target dashboard's variable definitions, which stays out of scope.
//
// It returns nil for anything that is not a Playlist, including a nil object, because the
// apiserver admission chain is shared with every other app installer. Every violation is
// collected instead of returning on the first one, so a rejected write describes all of
// them at once.
//
// Usage: the returned list is turned into the client-visible status error by
// NewPlaylistInvalidError.
func ValidatePlaylistObject(obj runtime.Object) field.ErrorList {
	subject, ok := playlistSubjectFor(obj)
	if !ok {
		return nil
	}

	var errs field.ErrorList
	itemsPath := field.NewPath("spec", "items")
	for i, item := range subject.items {
		errs = append(errs, validatePlaylistItem(item, itemsPath.Index(i))...)
	}
	return errs
}

// NewPlaylistInvalidError builds the status error for violations reported by
// ValidatePlaylistObject. apierrors.NewInvalid renders as HTTP 422 with one entry per
// violation in Details.Causes, each carrying the field path built below, which is what
// makes a rejected write actionable without reading the server log.
func NewPlaylistInvalidError(obj runtime.Object, errs field.ErrorList) *apierrors.StatusError {
	name := ""
	if subject, ok := playlistSubjectFor(obj); ok {
		name = subject.name
	}
	return apierrors.NewInvalid(playlistGroupKind, name, errs)
}

// validatePlaylistItem applies the published item contract to one item.
func validatePlaylistItem(item playlistItem, path *field.Path) field.ErrorList {
	var errs field.ErrorList

	typePath := path.Child("type")
	switch {
	case item.itemType == "":
		errs = append(errs, field.Required(typePath, "an item type is required"))
	case !slices.Contains(playlistItemTypes, playlistv1.PlaylistPlaylistItemType(item.itemType)):
		errs = append(errs, field.NotSupported(typePath, item.itemType, playlistItemTypes))
	}

	if item.value == "" {
		errs = append(errs, field.Required(path.Child("value"),
			"an item value is required; its meaning depends on the item type"))
	}

	// Variables on a dashboard_by_tag item are deliberately accepted: the playback runtime
	// ignores them, and rejecting a payload that carries them would break clients that
	// round-trip an item they did not author.
	return append(errs, validatePlaylistItemVariables(item.variables, path.Child("variables"))...)
}

// validatePlaylistItemVariables applies the published `variables` contract -- an optional
// object whose additionalProperties are arrays of strings -- to one item's map.
func validatePlaylistItemVariables(variables map[string][]string, path *field.Path) field.ErrorList {
	// An absent, null or empty map is a valid variable-less item: the field is optional and
	// the published schema constrains the map's members, not the map itself.
	if len(variables) == 0 {
		return nil
	}

	var errs field.ErrorList
	// Sorted so the causes of the resulting 422 come out in a stable order; Go randomises
	// map iteration.
	for _, name := range slices.Sorted(maps.Keys(variables)) {
		values := variables[name]
		namePath := path.Key(name)

		if strings.TrimSpace(name) == "" {
			// The playback runtime only emits a `var-` parameter for a variable whose trimmed
			// name is non-empty, so a blank key can never take effect on playback; it is
			// rejected rather than persisted as data that silently does nothing.
			errs = append(errs, field.Invalid(namePath, name, "a variable name must not be empty"))
		}

		if len(values) == 0 {
			// The field is modelled as one or more values, and the playback runtime skips an
			// empty list. A JSON `null` list and an empty JSON array both decode to a
			// zero-length slice, so this one rule covers both spellings.
			errs = append(errs, field.Invalid(namePath, values, "must contain at least one value"))
			continue
		}

		for i, value := range values {
			if value == "" {
				// Go decodes a JSON `null` array member into "", so once decoded the two are
				// indistinguishable: rejecting the empty string is the only enforceable form of
				// the published `items: {type: string}` constraint on array members.
				errs = append(errs, field.Invalid(namePath.Index(i), value, "a variable value must not be empty"))
			}
		}
	}
	return errs
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

	playlistValidator := &simple.Validator{
		ValidateFunc: func(ctx context.Context, req *app.AdmissionRequest) error {
			// ValidatePlaylistObject is invoked here and again from the apiserver admission
			// plugin in pkg/registry/apps/playlist/register.go, and neither call is redundant.
			// This one covers every wrapper that drives the app's own admission (an operator or
			// a webhook deployment). The SDK's apiserver admission wrapper, however, passes any
			// error returned from this hook through admission.NewForbidden, which reaches the
			// client as HTTP 403 with the causes flattened into a message; the register.go call
			// site is the only one that can preserve the Invalid/422 status and its per-field
			// causes. Do not delete either call.
			if errs := ValidatePlaylistObject(req.Object); len(errs) > 0 {
				return NewPlaylistInvalidError(req.Object, errs)
			}
			return nil
		},
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
