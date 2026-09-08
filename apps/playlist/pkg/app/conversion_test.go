package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/grafana/grafana-app-sdk/k8s"
	v1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

// TestExampleConverterPreservesVariables pins the three properties the optional per-item
// variables field depends on: the converter's JSON round trip carries every name and every
// value of a populated map without knowing about the field, an item that has no variables is
// re-encoded without the key at all so a playlist stored by an older Grafana keeps its exact
// wire format, and an item whose map is present but empty is re-encoded exactly like one that
// omits the key.
func TestExampleConverterPreservesVariables(t *testing.T) {
	// The source version has to differ from the target version. Convert short-circuits and
	// hands back the input bytes untouched when the source and target GVKs are equal, which
	// would satisfy every assertion below without the conversion ever running. Both versions
	// declare the same API group, so only the version differs and the guards still pass.
	//
	// The items repeat one dashboard UID with a different variable state each - several names
	// and values, no variables key at all, and a present but empty map - so every shape the
	// optional field can arrive in crosses versions in one pass and is asserted by index.
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

	// Every name and value of the populated map has to come through, in order, and nothing
	// else: an equality check on the whole map fails on a dropped, added or overwritten entry.
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
