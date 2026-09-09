package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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
