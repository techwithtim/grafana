package playlist

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestLegacyUpdateCommandToUnstructured(t *testing.T) {
	cmd := UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{
				Type:      "dashboard_by_uid",
				Value:     "xCmMwXdVz",
				Variables: map[string][]string{"host": {"a", "b"}},
			},
			{
				Type:  "dashboard_by_tag",
				Value: "graph-ng",
			},
		},
	}

	obj := LegacyUpdateCommandToUnstructured(cmd)

	spec, ok := obj.Object["spec"].(map[string]any)
	require.True(t, ok, "spec should be a map[string]any")
	items, ok := spec["items"].([]map[string]any)
	require.True(t, ok, "spec.items should be a []map[string]any")
	require.Len(t, items, 2)

	t.Run("item with variables", func(t *testing.T) {
		// The nested types matter as much as the values: unstructured content may only hold
		// JSON-compatible values, so a typed map[string][]string would break deep-copy and
		// serialization further down the dynamic client.
		assert.Equal(t, map[string]any{"host": []any{"a", "b"}}, items[0]["variables"])

		assert.Equal(t, "dashboard_by_uid", items[0]["type"])
		assert.Equal(t, "xCmMwXdVz", items[0]["value"])
		assert.Len(t, items[0], 3, "item should carry exactly type, value and variables")
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"type":  "dashboard_by_tag",
			"value": "graph-ng",
		}, items[1], "a variable-less item must serialize exactly as it did before this field existed")
		assert.NotContains(t, items[1], "variables", "an empty map must not add a variables key")
	})
}

func TestUnstructuredToLegacyPlaylistDTO(t *testing.T) {
	// The conversion reads spec, spec.title and spec.interval through unguarded type
	// assertions, so a fixture missing any of them panics instead of failing.
	obj := unstructured.Unstructured{
		Object: map[string]any{
			"spec": map[string]any{
				"title":    "Test",
				"interval": "20s",
				"items": []any{
					map[string]any{
						"type":  "dashboard_by_uid",
						"value": "xCmMwXdVz",
						"variables": map[string]any{
							"host":    []any{"a", "b"},
							"cluster": []any{"c"},
						},
					},
					map[string]any{
						"type":  "dashboard_by_tag",
						"value": "graph-ng",
					},
				},
			},
		},
	}

	dto := UnstructuredToLegacyPlaylistDTO(obj)

	require.NotNil(t, dto)
	require.Len(t, dto.Items, 2)

	t.Run("item with variables", func(t *testing.T) {
		assert.Equal(t, map[string][]string{
			"host":    {"a", "b"},
			"cluster": {"c"},
		}, dto.Items[0].Variables)

		assert.Equal(t, "dashboard_by_uid", dto.Items[0].Type)
		assert.Equal(t, "xCmMwXdVz", dto.Items[0].Value)
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Nil(t, dto.Items[1].Variables, "an item without variables must decode to a nil map")
		assert.Equal(t, "dashboard_by_tag", dto.Items[1].Type)
		assert.Equal(t, "graph-ng", dto.Items[1].Value)
	})
}
