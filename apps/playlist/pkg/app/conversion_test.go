package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/conversion"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"

	"github.com/grafana/grafana-app-sdk/k8s"
	v0alpha1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v0alpha1"
	v1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

func TestExampleConverterPreservesVariables(t *testing.T) {
	// The source version has to differ from the target version: Convert hands back the input
	// bytes untouched when the source and target GVKs are equal, so no conversion would run.
	raw := k8s.RawKind{
		APIVersion: "playlist.grafana.app/v0alpha1",
		Kind:       "Playlist",
		Raw: []byte(`{
			"apiVersion": "playlist.grafana.app/v0alpha1",
			"kind": "Playlist",
			"metadata": {
				"name": "test-playlist"
			},
			"spec": {
				"title": "Test",
				"interval": "20s",
				"items": [
					{
						"type": "dashboard_by_uid",
						"value": "xCmMwXdVz",
						"variables": {"host": ["a", "b"], "cluster": ["c"]}
					},
					{
						"type": "dashboard_by_uid",
						"value": "xCmMwXdVz"
					},
					{
						"type": "dashboard_by_uid",
						"value": "xCmMwXdVz",
						"variables": {}
					}
				]
			}
		}`),
	}

	converted, err := NewExampleConverter().Convert(raw, "playlist.grafana.app/v1")
	if err != nil {
		t.Fatalf("Convert returned an unexpected error: %v", err)
	}

	out := &v1.Playlist{}
	if err := json.Unmarshal(converted, out); err != nil {
		t.Fatalf("unable to unmarshal converted bytes into v1.Playlist: %v", err)
	}
	if len(out.Spec.Items) != 3 {
		t.Fatalf("len(out.Spec.Items) = %d, want %d", len(out.Spec.Items), 3)
	}

	want := map[string][]string{"host": {"a", "b"}, "cluster": {"c"}}
	if got := out.Spec.Items[0].Variables; !reflect.DeepEqual(got, want) {
		t.Errorf("out.Spec.Items[0].Variables = %#v, want %#v", got, want)
	}
	if got := out.Spec.Items[1].Variables; got != nil {
		t.Errorf("out.Spec.Items[1].Variables = %#v, want nil", got)
	}
	if got := out.Spec.Items[2].Variables; got != nil {
		t.Errorf("out.Spec.Items[2].Variables = %#v, want nil", got)
	}

	// Typed decoding conflates an absent key with an explicit null - both leave the field nil -
	// while a present but empty object stays distinguishable as a non-nil map of length zero.
	// Decoding the source the same way the converter does pins that it really was handed an
	// empty map for the third item, so that item's nil above is the omitempty tag dropping the
	// key on the way out rather than a distinction lost on the way in.
	source := &v1.Playlist{}
	if err := json.Unmarshal(raw.Raw, source); err != nil {
		t.Fatalf("unable to unmarshal the source bytes into v1.Playlist: %v", err)
	}
	if len(source.Spec.Items) != 3 {
		t.Fatalf("len(source.Spec.Items) = %d, want %d", len(source.Spec.Items), 3)
	}
	if got := source.Spec.Items[1].Variables; got != nil {
		t.Errorf("source spec.items[1].Variables = %#v, want nil", got)
	}
	if got := source.Spec.Items[2].Variables; got == nil || len(got) != 0 {
		t.Errorf("source spec.items[2].Variables = %#v, want an empty, non-nil map", got)
	}

	// The typed values cannot show which keys the converter wrote, so check key presence on the
	// encoded output as well.
	var encoded struct {
		Spec struct {
			Items []map[string]json.RawMessage `json:"items"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(converted, &encoded); err != nil {
		t.Fatalf("unable to unmarshal converted bytes into a key-presence shape: %v", err)
	}
	if len(encoded.Spec.Items) != 3 {
		t.Fatalf("len(encoded.Spec.Items) = %d, want %d", len(encoded.Spec.Items), 3)
	}

	if _, ok := encoded.Spec.Items[0]["variables"]; !ok {
		t.Errorf(`encoded spec.items[0] has the "variables" key = false, want true`)
	}
	if value, ok := encoded.Spec.Items[1]["variables"]; ok {
		t.Errorf(`encoded spec.items[1] has the "variables" key = true (%s), want false`, value)
	}
	if value, ok := encoded.Spec.Items[2]["variables"]; ok {
		t.Errorf(`encoded spec.items[2] has the "variables" key = true (%s), want false`, value)
	}
}

// itemFixture describes one playlist item in a version-agnostic way, so a single table of
// cases can be run against both served versions.
type itemFixture struct {
	itemType  string
	value     string
	variables map[string][]string
}

// playlistBuilders builds the same fixture as each served version's concrete Go type. Both
// are exercised for every case because the validator type-switches on them separately.
var playlistBuilders = []struct {
	version string
	build   func(name string, items []itemFixture) runtime.Object
}{
	{
		version: "v1",
		build: func(name string, items []itemFixture) runtime.Object {
			obj := &v1.Playlist{}
			obj.SetName(name)
			obj.Spec = v1.PlaylistSpec{Title: "Test", Interval: "5m", Items: make([]v1.PlaylistPlaylistItem, 0, len(items))}
			for _, item := range items {
				obj.Spec.Items = append(obj.Spec.Items, v1.PlaylistPlaylistItem{
					Type:      v1.PlaylistPlaylistItemType(item.itemType),
					Value:     item.value,
					Variables: item.variables,
				})
			}
			return obj
		},
	},
	{
		version: "v0alpha1",
		build: func(name string, items []itemFixture) runtime.Object {
			obj := &v0alpha1.Playlist{}
			obj.SetName(name)
			obj.Spec = v0alpha1.PlaylistSpec{Title: "Test", Interval: "5m", Items: make([]v0alpha1.PlaylistPlaylistItem, 0, len(items))}
			for _, item := range items {
				obj.Spec.Items = append(obj.Spec.Items, v0alpha1.PlaylistPlaylistItem{
					Type:      v0alpha1.PlaylistPlaylistItemType(item.itemType),
					Value:     item.value,
					Variables: item.variables,
				})
			}
			return obj
		},
	},
}

// describeErrors renders a violation list as "<error type> <field path>" entries, in the
// order the validator produced them, which is the order the 422 causes appear in.
func describeErrors(errs field.ErrorList) []string {
	described := make([]string, 0, len(errs))
	for _, err := range errs {
		described = append(described, string(err.Type)+" "+err.Field)
	}
	return described
}

func TestValidatePlaylistObject(t *testing.T) {
	for _, tc := range []struct {
		name  string
		items []itemFixture
		want  []string
	}{
		{
			name:  "no items",
			items: []itemFixture{},
			want:  []string{},
		},
		{
			name: "every published item type is accepted",
			items: []itemFixture{
				{itemType: "dashboard_by_uid", value: "xCmMwXdVz"},
				{itemType: "dashboard_by_tag", value: "graph-ng"},
				{itemType: "dashboard_by_id", value: "3"},
			},
			want: []string{},
		},
		{
			name: "valid item with variables",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"host": {"a", "b"}, "cluster": {"c"}},
			}},
			want: []string{},
		},
		{
			name: "variables are accepted on a dashboard_by_tag item",
			// The runtime ignores them, and rejecting the payload would break a client that
			// round-trips an item it did not author.
			items: []itemFixture{{
				itemType:  "dashboard_by_tag",
				value:     "graph-ng",
				variables: map[string][]string{"host": {"a"}},
			}},
			want: []string{},
		},
		{
			name:  "nil variables map",
			items: []itemFixture{{itemType: "dashboard_by_uid", value: "xCmMwXdVz", variables: nil}},
			want:  []string{},
		},
		{
			name:  "empty variables map",
			items: []itemFixture{{itemType: "dashboard_by_uid", value: "xCmMwXdVz", variables: map[string][]string{}}},
			want:  []string{},
		},
		{
			name:  "missing type",
			items: []itemFixture{{value: "xCmMwXdVz"}},
			want:  []string{"FieldValueRequired spec.items[0].type"},
		},
		{
			name:  "missing value",
			items: []itemFixture{{itemType: "dashboard_by_uid"}},
			want:  []string{"FieldValueRequired spec.items[0].value"},
		},
		{
			name:  "out of enum type",
			items: []itemFixture{{itemType: "dashboard_by_unicorn", value: "x"}},
			want:  []string{"FieldValueNotSupported spec.items[0].type"},
		},
		{
			name:  "type is matched exactly",
			items: []itemFixture{{itemType: "Dashboard_By_Uid", value: "x"}},
			want:  []string{"FieldValueNotSupported spec.items[0].type"},
		},
		{
			name: "empty variable name",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"": {"a"}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[]"},
		},
		{
			name: "whitespace only variable name",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{" ": {"a"}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[ ]"},
		},
		{
			name: "zero width space only variable name",
			// U+200B is not Unicode whitespace, so trimming spaces admitted it and playback
			// then emitted an invisible `var-%E2%80%8B` parameter. The full invisible-character
			// catalogue is in app_test.go; these two are the cases the layers disagreed on.
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"\u200b": {"a"}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[\u200b]"},
		},
		{
			name: "byte order mark only variable name",
			// U+FEFF was stored by the API and then skipped by playback, so the two layers
			// disagreed about whether the variable existed at all.
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"\ufeff": {"a"}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[\ufeff]"},
		},
		{
			name: "nil value list",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"host": nil},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[host]"},
		},
		{
			name: "empty value list",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"host": {}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[host]"},
		},
		{
			name: "empty value among good ones",
			items: []itemFixture{{
				itemType:  "dashboard_by_uid",
				value:     "xCmMwXdVz",
				variables: map[string][]string{"host": {"a", "", "b"}},
			}},
			want: []string{"FieldValueInvalid spec.items[0].variables[host][1]"},
		},
		{
			name: "every violation is reported, in a stable order",
			items: []itemFixture{
				{value: "xCmMwXdVz"},
				{itemType: "dashboard_by_uid"},
				{itemType: "dashboard_by_unicorn"},
				{
					itemType:  "dashboard_by_uid",
					value:     "xCmMwXdVz",
					variables: map[string][]string{"host": {"a", ""}, "cluster": nil, "": {"a"}},
				},
			},
			want: []string{
				"FieldValueRequired spec.items[0].type",
				"FieldValueRequired spec.items[1].value",
				"FieldValueNotSupported spec.items[2].type",
				"FieldValueRequired spec.items[2].value",
				"FieldValueInvalid spec.items[3].variables[]",
				"FieldValueInvalid spec.items[3].variables[cluster]",
				"FieldValueInvalid spec.items[3].variables[host][1]",
			},
		},
	} {
		for _, builder := range playlistBuilders {
			t.Run(tc.name+"/"+builder.version, func(t *testing.T) {
				got := describeErrors(ValidatePlaylistObject(builder.build("test-playlist", tc.items)))
				if !reflect.DeepEqual(got, tc.want) {
					t.Errorf("ValidatePlaylistObject() = %v, want %v", got, tc.want)
				}
			})
		}
	}
}

func TestValidatePlaylistObjectEnumDetail(t *testing.T) {
	// The rejected value and the list of supported ones both reach the client, so a caller
	// can correct the payload from the response alone.
	for _, builder := range playlistBuilders {
		t.Run(builder.version, func(t *testing.T) {
			errs := ValidatePlaylistObject(builder.build("test-playlist", []itemFixture{
				{itemType: "dashboard_by_unicorn", value: "x"},
			}))
			if len(errs) != 1 {
				t.Fatalf("len(errs) = %d, want 1 (%v)", len(errs), describeErrors(errs))
			}
			if got, want := errs[0].BadValue, "dashboard_by_unicorn"; got != want {
				t.Errorf("errs[0].BadValue = %#v, want %#v", got, want)
			}
			for _, published := range []string{"dashboard_by_tag", "dashboard_by_uid", "dashboard_by_id"} {
				if !strings.Contains(errs[0].Detail, published) {
					t.Errorf("errs[0].Detail = %q, want it to list %q", errs[0].Detail, published)
				}
			}
		})
	}
}

func TestValidatePlaylistObjectIgnoresEverythingElse(t *testing.T) {
	// The apiserver admission chain is shared with every other app installer, and a DELETE
	// carries no object, so anything that is not a playlist has to be a silent no-op.
	for _, tc := range []struct {
		name string
		obj  runtime.Object
	}{
		{name: "nil object", obj: nil},
		{name: "another group's resource", obj: &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "example.grafana.app/v1",
			"kind":       "Example",
		}}},
		{name: "typed nil v1 playlist", obj: (*v1.Playlist)(nil)},
		{name: "typed nil v0alpha1 playlist", obj: (*v0alpha1.Playlist)(nil)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if errs := ValidatePlaylistObject(tc.obj); errs != nil {
				t.Errorf("ValidatePlaylistObject() = %v, want nil", describeErrors(errs))
			}
		})
	}
}

func TestNewPlaylistInvalidError(t *testing.T) {
	for _, builder := range playlistBuilders {
		t.Run(builder.version, func(t *testing.T) {
			obj := builder.build("broken-playlist", []itemFixture{
				{value: "xCmMwXdVz"},
				{itemType: "dashboard_by_uid", value: "xCmMwXdVz", variables: map[string][]string{"host": nil}},
			})
			errs := ValidatePlaylistObject(obj)
			if len(errs) != 2 {
				t.Fatalf("len(errs) = %d, want 2 (%v)", len(errs), describeErrors(errs))
			}

			status := NewPlaylistInvalidError(obj, errs)
			if !apierrors.IsInvalid(status) {
				t.Fatalf("apierrors.IsInvalid() = false, reason %q", status.ErrStatus.Reason)
			}
			// Invalid is the status that renders as HTTP 422 with one cause per violation.
			if got, want := status.ErrStatus.Code, int32(422); got != want {
				t.Errorf("status code = %d, want %d", got, want)
			}
			if status.ErrStatus.Details == nil {
				t.Fatal("status.ErrStatus.Details = nil, want the group, kind, name and causes")
			}
			if got, want := status.ErrStatus.Details.Group, v1.APIGroup; got != want {
				t.Errorf("details.Group = %q, want %q", got, want)
			}
			if got, want := status.ErrStatus.Details.Kind, "Playlist"; got != want {
				t.Errorf("details.Kind = %q, want %q", got, want)
			}
			if got, want := status.ErrStatus.Details.Name, "broken-playlist"; got != want {
				t.Errorf("details.Name = %q, want %q", got, want)
			}

			gotFields := make([]string, 0, len(status.ErrStatus.Details.Causes))
			for _, cause := range status.ErrStatus.Details.Causes {
				gotFields = append(gotFields, cause.Field)
			}
			wantFields := []string{"spec.items[0].type", "spec.items[1].variables[host]"}
			if !reflect.DeepEqual(gotFields, wantFields) {
				t.Errorf("cause fields = %v, want %v", gotFields, wantFields)
			}
		})
	}
}

func TestNewPlaylistInvalidErrorForANonPlaylist(t *testing.T) {
	// Defensive: the constructor is only ever called with the object the violations came
	// from, but it must not panic if that pairing is ever broken.
	status := NewPlaylistInvalidError(nil, field.ErrorList{
		field.Required(field.NewPath("spec", "items").Index(0).Child("type"), "an item type is required"),
	})
	if !apierrors.IsInvalid(status) {
		t.Fatalf("apierrors.IsInvalid() = false, reason %q", status.ErrStatus.Reason)
	}
	if got := status.ErrStatus.Details.Name; got != "" {
		t.Errorf("details.Name = %q, want an empty name", got)
	}
}

// conversionScheme builds a scheme registered the way the App SDK's installer registers this
// group: both served versions, plus the group's internal hub version under the preferred
// version's Go type (grafana-app-sdk k8s/apiserver/installer.go:289-291). The hub sharing the
// v1 Go type is what produces the object every conversion below has to survive -- a
// *v1.Playlist whose apiVersion and kind the apiserver has cleared.
func conversionScheme(t *testing.T) *runtime.Scheme {
	t.Helper()

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(playlistV1GVK, &v1.Playlist{})
	scheme.AddKnownTypeWithName(playlistV0alpha1GVK, &v0alpha1.Playlist{})
	scheme.AddKnownTypeWithName(internalPlaylistGVK(), &v1.Playlist{})

	if err := RegisterConversions(scheme); err != nil {
		t.Fatalf("RegisterConversions returned an unexpected error: %v", err)
	}
	return scheme
}

func internalPlaylistGVK() schema.GroupVersionKind {
	return schema.GroupVersionKind{
		Group:   playlistV1GVK.Group,
		Version: runtime.APIVersionInternal,
		Kind:    playlistV1GVK.Kind,
	}
}

// v0alpha1Fixture is a Playlist carrying every part of an object a conversion has to move:
// the metadata an apiserver stamps on it (including the field ownership these conversions
// exist to preserve), a spec with and without item variables, and a non-empty status.
func v0alpha1Fixture() *v0alpha1.Playlist {
	created := metav1.Date(2026, 9, 10, 6, 0, 0, 0, time.UTC)
	owned := metav1.Date(2026, 9, 10, 6, 1, 0, 0, time.UTC)
	descriptive := "recorded by the conversion test"

	return &v0alpha1.Playlist{
		TypeMeta: metav1.TypeMeta{
			APIVersion: playlistV0alpha1GVK.GroupVersion().String(),
			Kind:       playlistV0alpha1GVK.Kind,
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:              "across-versions",
			Namespace:         "default",
			UID:               "8f1e0a3c-1d5b-4f2a-9c1e-2f3d4b5a6c7d",
			ResourceVersion:   "1789019651030981",
			Generation:        3,
			CreationTimestamp: created,
			Labels:            map[string]string{"grafana.app/managedBy": "test"},
			Annotations:       map[string]string{"grafana.app/updatedBy": "user:1"},
			Finalizers:        []string{"playlist.grafana.app/cleanup"},
			ManagedFields: []metav1.ManagedFieldsEntry{{
				Manager:    "qa-v0alpha1-writer",
				Operation:  metav1.ManagedFieldsOperationUpdate,
				APIVersion: playlistV0alpha1GVK.GroupVersion().String(),
				Time:       &owned,
				FieldsType: "FieldsV1",
				FieldsV1:   metav1.NewFieldsV1(`{"f:spec":{"f:interval":{},"f:items":{},"f:title":{}}}`),
			}},
		},
		Spec: v0alpha1.PlaylistSpec{
			Title:    "Written through v0alpha1",
			Interval: "5m",
			Items: []v0alpha1.PlaylistPlaylistItem{
				{
					Type:      v0alpha1.PlaylistPlaylistItemTypeDashboardByUid,
					Value:     "xCmMwXdVz",
					Variables: map[string][]string{"host": {"h1", "h2"}, "cluster": {"c1"}},
				},
				{
					Type:  v0alpha1.PlaylistPlaylistItemTypeDashboardByTag,
					Value: "graph-ng",
				},
			},
		},
		Status: v0alpha1.PlaylistStatus{
			OperatorStates: map[string]v0alpha1.PlayliststatusOperatorState{
				"qa-probe": {
					LastEvaluation:   "1789019651030981",
					State:            v0alpha1.PlaylistStatusOperatorStateStateSuccess,
					DescriptiveState: &descriptive,
					Details:          map[string]any{"reason": "converted"},
				},
			},
			AdditionalFields: map[string]any{"reserved": "value"},
		},
	}
}

// bodyJSON renders the spec and status of either version's Playlist for comparison across
// versions, where the Go types differ but the JSON shape is identical by construction.
func bodyJSON(t *testing.T, spec any, status any) string {
	t.Helper()

	encoded, err := json.Marshal(map[string]any{"spec": spec, "status": status})
	if err != nil {
		t.Fatalf("unable to marshal a playlist body: %v", err)
	}
	return string(encoded)
}

// TestRegisterConversionsSurvivesTheInternalHub is the unit-level form of the defect behind
// the cross-version managedFields loss: the second hop starts from a *v1.Playlist whose
// TypeMeta the apiserver cleared, which is exactly what the App SDK's own conversion could
// not encode.
func TestRegisterConversionsSurvivesTheInternalHub(t *testing.T) {
	scheme := conversionScheme(t)
	source := v0alpha1Fixture()

	hub, err := scheme.ConvertToVersion(source, internalPlaylistGVK().GroupVersion())
	if err != nil {
		t.Fatalf("converting v0alpha1 to the internal hub returned an unexpected error: %v", err)
	}
	hubPlaylist, ok := hub.(*v1.Playlist)
	if !ok {
		t.Fatalf("the internal hub object is %T, want *v1.Playlist", hub)
	}
	// The state the SDK's conversion tripped over, asserted rather than assumed: the apiserver
	// strips the identity of an object it converts into the internal version.
	if hubPlaylist.APIVersion != "" || hubPlaylist.Kind != "" {
		t.Fatalf("the hub object still names %q/%q, so this test no longer covers the cleared-TypeMeta case",
			hubPlaylist.APIVersion, hubPlaylist.Kind)
	}

	back, err := scheme.ConvertToVersion(hubPlaylist, playlistV0alpha1GVK.GroupVersion())
	if err != nil {
		t.Fatalf("converting the internal hub object back to v0alpha1 returned an unexpected error: %v", err)
	}
	roundTripped, ok := back.(*v0alpha1.Playlist)
	if !ok {
		t.Fatalf("the converted object is %T, want *v0alpha1.Playlist", back)
	}

	if got, want := roundTripped.APIVersion, playlistV0alpha1GVK.GroupVersion().String(); got != want {
		t.Errorf("apiVersion = %q, want %q", got, want)
	}
	if !reflect.DeepEqual(roundTripped.ObjectMeta, source.ObjectMeta) {
		t.Errorf("metadata after the round trip = %#v, want %#v", roundTripped.ObjectMeta, source.ObjectMeta)
	}
	if got, want := bodyJSON(t, roundTripped.Spec, roundTripped.Status), bodyJSON(t, source.Spec, source.Status); got != want {
		t.Errorf("spec and status after the round trip = %s, want %s", got, want)
	}
}

// TestRegisterConversionsBothDirections pins the full-fidelity conversion of every part of an
// object, in both directions, through the scheme the apiserver uses.
func TestRegisterConversionsBothDirections(t *testing.T) {
	scheme := conversionScheme(t)
	source := v0alpha1Fixture()

	converted, err := scheme.ConvertToVersion(source, playlistV1GVK.GroupVersion())
	if err != nil {
		t.Fatalf("converting v0alpha1 to v1 returned an unexpected error: %v", err)
	}
	asV1, ok := converted.(*v1.Playlist)
	if !ok {
		t.Fatalf("the converted object is %T, want *v1.Playlist", converted)
	}
	if got, want := asV1.APIVersion, playlistV1GVK.GroupVersion().String(); got != want {
		t.Errorf("apiVersion = %q, want %q", got, want)
	}
	if !reflect.DeepEqual(asV1.ObjectMeta, source.ObjectMeta) {
		t.Errorf("v1 metadata = %#v, want %#v", asV1.ObjectMeta, source.ObjectMeta)
	}
	if got, want := bodyJSON(t, asV1.Spec, asV1.Status), bodyJSON(t, source.Spec, source.Status); got != want {
		t.Errorf("v1 spec and status = %s, want %s", got, want)
	}
	// The item variables are the field this feature added, so they are checked as typed values
	// too: an item that carries them keeps every name and value, and an item that does not
	// stays without the field rather than gaining an empty map.
	wantVariables := map[string][]string{"host": {"h1", "h2"}, "cluster": {"c1"}}
	if got := asV1.Spec.Items[0].Variables; !reflect.DeepEqual(got, wantVariables) {
		t.Errorf("v1 spec.items[0].variables = %#v, want %#v", got, wantVariables)
	}
	if got := asV1.Spec.Items[1].Variables; got != nil {
		t.Errorf("v1 spec.items[1].variables = %#v, want nil", got)
	}

	// The source must not have been touched by the conversion, and the destination must not
	// share the maps and slices it copied: an apiserver that mutates one object would
	// otherwise change the other.
	asV1.Spec.Items[0].Variables["host"][0] = "mutated"
	asV1.Labels["grafana.app/managedBy"] = "mutated"
	asV1.Status.OperatorStates["qa-probe"].Details["reason"] = "mutated"
	if got := source.Spec.Items[0].Variables["host"][0]; got != "h1" {
		t.Errorf("mutating the converted object changed the source variables to %q", got)
	}
	if got := source.Labels["grafana.app/managedBy"]; got != "test" {
		t.Errorf("mutating the converted object changed the source labels to %q", got)
	}
	if got := source.Status.OperatorStates["qa-probe"].Details["reason"]; got != "converted" {
		t.Errorf("mutating the converted object changed the source status details to %v", got)
	}

	// And back, from a fresh fixture so the mutations above cannot be mistaken for fidelity.
	source = v0alpha1Fixture()
	asV1, ok = mustConvert(t, scheme, source, playlistV1GVK.GroupVersion()).(*v1.Playlist)
	if !ok {
		t.Fatalf("the converted object is not a *v1.Playlist")
	}
	reverted, ok := mustConvert(t, scheme, asV1, playlistV0alpha1GVK.GroupVersion()).(*v0alpha1.Playlist)
	if !ok {
		t.Fatalf("the reverted object is not a *v0alpha1.Playlist")
	}
	if !reflect.DeepEqual(reverted.ObjectMeta, source.ObjectMeta) {
		t.Errorf("v0alpha1 metadata after both conversions = %#v, want %#v", reverted.ObjectMeta, source.ObjectMeta)
	}
	if got, want := bodyJSON(t, reverted.Spec, reverted.Status), bodyJSON(t, source.Spec, source.Status); got != want {
		t.Errorf("v0alpha1 spec and status after both conversions = %s, want %s", got, want)
	}
}

func mustConvert(t *testing.T, scheme *runtime.Scheme, in runtime.Object, target schema.GroupVersion) runtime.Object {
	t.Helper()

	out, err := scheme.ConvertToVersion(in, target)
	if err != nil {
		t.Fatalf("converting %T to %s returned an unexpected error: %v", in, target, err)
	}
	return out
}

// TestConvertPlaylistReplacesTheDestination covers the direct call the scheme's Convert makes
// available to callers that supply their own destination: a conversion replaces the object it
// is given, so nothing of a reused destination may survive.
func TestConvertPlaylistReplacesTheDestination(t *testing.T) {
	source := v0alpha1Fixture()
	destination := &v1.Playlist{
		ObjectMeta: metav1.ObjectMeta{
			Name:   "stale",
			Labels: map[string]string{"stale": "label"},
		},
		Spec: v1.PlaylistSpec{
			Title:    "stale title",
			Interval: "99m",
			Items: []v1.PlaylistPlaylistItem{
				{Type: v1.PlaylistPlaylistItemTypeDashboardById, Value: "7", Variables: map[string][]string{"stale": {"variable"}}},
				{Type: v1.PlaylistPlaylistItemTypeDashboardByTag, Value: "stale"},
				{Type: v1.PlaylistPlaylistItemTypeDashboardByTag, Value: "stale"},
			},
		},
		Status: v1.PlaylistStatus{
			OperatorStates: map[string]v1.PlayliststatusOperatorState{"stale": {LastEvaluation: "0"}},
		},
	}

	if err := convertPlaylistV0alpha1ToV1(source, destination, nil); err != nil {
		t.Fatalf("convertPlaylistV0alpha1ToV1 returned an unexpected error: %v", err)
	}

	if got := destination.Name; got != source.Name {
		t.Errorf("name = %q, want %q", got, source.Name)
	}
	if _, ok := destination.Labels["stale"]; ok {
		t.Errorf("the stale label survived the conversion: %#v", destination.Labels)
	}
	if got := len(destination.Spec.Items); got != len(source.Spec.Items) {
		t.Errorf("len(spec.items) = %d, want %d", got, len(source.Spec.Items))
	}
	if _, ok := destination.Status.OperatorStates["stale"]; ok {
		t.Errorf("the stale operator state survived the conversion: %#v", destination.Status.OperatorStates)
	}
	if got, want := bodyJSON(t, destination.Spec, destination.Status), bodyJSON(t, source.Spec, source.Status); got != want {
		t.Errorf("spec and status = %s, want %s", got, want)
	}
}

// TestConvertPlaylistRejectsOtherTypes covers the guards on the conversion functions. The
// scheme only ever calls them with the pair they were registered for, so a mismatch means
// something else is calling them, and it has to be told rather than silently mis-converted.
func TestConvertPlaylistRejectsOtherTypes(t *testing.T) {
	cases := []struct {
		name    string
		convert func(a, b any, scope conversion.Scope) error
		a       any
		b       any
	}{
		{"v0alpha1 to v1 with a wrong source", convertPlaylistV0alpha1ToV1, &v1.Playlist{}, &v1.Playlist{}},
		{"v0alpha1 to v1 with a wrong destination", convertPlaylistV0alpha1ToV1, &v0alpha1.Playlist{}, &v0alpha1.Playlist{}},
		{"v1 to v0alpha1 with a wrong source", convertPlaylistV1ToV0alpha1, &v0alpha1.Playlist{}, &v0alpha1.Playlist{}},
		{"v1 to v0alpha1 with a wrong destination", convertPlaylistV1ToV0alpha1, &v1.Playlist{}, &v1.Playlist{}},
		{"v0alpha1 to v1 with a nil source", convertPlaylistV0alpha1ToV1, nil, &v1.Playlist{}},
		{"v1 to v0alpha1 with a nil destination", convertPlaylistV1ToV0alpha1, &v1.Playlist{}, nil},
		// A typed nil satisfies the type assertion, so the guards have to reject it by value
		// as well: dereferencing it would panic inside the apiserver's conversion path.
		{"v0alpha1 to v1 with a typed nil source", convertPlaylistV0alpha1ToV1, (*v0alpha1.Playlist)(nil), &v1.Playlist{}},
		{"v0alpha1 to v1 with a typed nil destination", convertPlaylistV0alpha1ToV1, &v0alpha1.Playlist{}, (*v1.Playlist)(nil)},
		{"v1 to v0alpha1 with a typed nil source", convertPlaylistV1ToV0alpha1, (*v1.Playlist)(nil), &v0alpha1.Playlist{}},
		{"v1 to v0alpha1 with a typed nil destination", convertPlaylistV1ToV0alpha1, &v1.Playlist{}, (*v0alpha1.Playlist)(nil)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.convert(tc.a, tc.b, nil); err == nil {
				t.Fatalf("conversion of (%T, %T) returned no error", tc.a, tc.b)
			}
		})
	}
}

func TestRegisterConversionsRejectsANilScheme(t *testing.T) {
	if err := RegisterConversions(nil); err == nil {
		t.Fatal("RegisterConversions(nil) returned no error")
	}
}
