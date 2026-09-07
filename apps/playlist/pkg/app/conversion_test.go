package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/grafana/grafana-app-sdk/k8s"
	v1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

// TestExampleConverterPreservesVariables pins the two properties the optional per-item
// variables field depends on: the converter's JSON round trip carries it without knowing
// about it, and an item that has no variables is re-encoded without the key at all, so a
// playlist stored by an older Grafana keeps its exact wire format.
func TestExampleConverterPreservesVariables(t *testing.T) {
	// The source version has to differ from the target version. Convert short-circuits and
	// hands back the input bytes untouched when the source and target GVKs are equal, which
	// would satisfy every assertion below without the conversion ever running. Both versions
	// declare the same API group, so only the version differs and the guards still pass.
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
						"variables": {"host": ["a", "b"]}
					},
					{
						"type": "dashboard_by_uid",
						"value": "xCmMwXdVz"
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
	if len(out.Spec.Items) != 2 {
		t.Fatalf("len(out.Spec.Items) = %d, want %d", len(out.Spec.Items), 2)
	}

	want := map[string][]string{"host": {"a", "b"}}
	if got := out.Spec.Items[0].Variables; !reflect.DeepEqual(got, want) {
		t.Errorf("out.Spec.Items[0].Variables = %#v, want %#v", got, want)
	}
	if got := out.Spec.Items[1].Variables; got != nil {
		t.Errorf("out.Spec.Items[1].Variables = %#v, want nil", got)
	}

	// Decoding into the typed object cannot tell an absent key from a null or empty one, so
	// check key presence on the encoded output as well.
	var encoded struct {
		Spec struct {
			Items []map[string]json.RawMessage `json:"items"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(converted, &encoded); err != nil {
		t.Fatalf("unable to unmarshal converted bytes into a key-presence shape: %v", err)
	}
	if len(encoded.Spec.Items) != 2 {
		t.Fatalf("len(encoded.Spec.Items) = %d, want %d", len(encoded.Spec.Items), 2)
	}

	if _, ok := encoded.Spec.Items[0]["variables"]; !ok {
		t.Errorf(`encoded spec.items[0] has the "variables" key = false, want true`)
	}
	if value, ok := encoded.Spec.Items[1]["variables"]; ok {
		t.Errorf(`encoded spec.items[1] has the "variables" key = true (%s), want false`, value)
	}
}
