package playlist

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	playlistapp "github.com/grafana/grafana/apps/playlist/pkg/app"
)

func TestLegacyUpdateCommandToUnstructured(t *testing.T) {
	cmd := UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{
				Type:  "dashboard_by_uid",
				Value: "xCmMwXdVz",
				Variables: map[string][]string{
					"host":    {"a", "b"},
					"cluster": {"c"},
				},
			},
			{
				// The same dashboard uid on purpose: one parameterized dashboard rotates
				// through several hosts by appearing once per variable set.
				Type:      "dashboard_by_uid",
				Value:     "xCmMwXdVz",
				Variables: map[string][]string{"host": {"z"}},
			},
			{
				// An initialized but empty map is a different input state from a nil one,
				// and it has to reach the same output.
				Type:      "dashboard_by_uid",
				Value:     "AAbbCCdd",
				Variables: map[string][]string{},
			},
			{
				Type:  "dashboard_by_tag",
				Value: "graph-ng",
			},
		},
	}

	obj, err := LegacyUpdateCommandToUnstructured(cmd)
	require.NoError(t, err, "this fixture is well within the playlist budget")

	spec, ok := obj.Object["spec"].(map[string]any)
	require.True(t, ok, "spec should be a map[string]any")
	items, ok := spec["items"].([]any)
	require.True(t, ok, "spec.items should be an []any, got %T", spec["items"])
	require.Len(t, items, 4, "every command item must produce exactly one entry, in order")

	entries := make([]map[string]any, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		require.True(t, ok, "spec.items[%d] should be a map[string]any, got %T", i, item)
		entries[i] = entry
	}

	t.Run("output is safe for kubernetes runtime operations", func(t *testing.T) {
		// The nested types matter as much as the values. Everything that handles an
		// Unstructured -- the dynamic client, admission, the apiserver -- walks its content
		// with runtime.DeepCopyJSONValue, which panics on a container it does not recognize
		// ([]map[string]any is one), so a shape that fails here fails in production too.
		require.NotPanics(t, func() { _ = obj.DeepCopy() })

		copied, found, err := unstructured.NestedSlice(obj.Object, "spec", "items")
		require.NoError(t, err)
		require.True(t, found)
		require.Len(t, copied, 4)

		first, ok := copied[0].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, map[string]any{
			"host":    []any{"a", "b"},
			"cluster": []any{"c"},
		}, first["variables"], "a deep copy must carry the nested variable values through unchanged")
	})

	t.Run("item with several variables", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"host":    []any{"a", "b"},
			"cluster": []any{"c"},
		}, entries[0]["variables"])

		assert.Equal(t, "dashboard_by_uid", entries[0]["type"])
		assert.Equal(t, "xCmMwXdVz", entries[0]["value"])
		assert.Len(t, entries[0], 3, "item should carry exactly type, value and variables")
	})

	t.Run("repeated dashboard uid keeps its own variables", func(t *testing.T) {
		assert.Equal(t, "dashboard_by_uid", entries[1]["type"])
		assert.Equal(t, "xCmMwXdVz", entries[1]["value"])
		assert.Equal(t, entries[0]["value"], entries[1]["value"], "the fixture must list one uid twice")
		assert.Equal(t, map[string]any{"host": []any{"z"}}, entries[1]["variables"],
			"two entries for the same dashboard must keep their own variables, in order")
		assert.Len(t, entries[1], 3)
	})

	t.Run("item with an empty variables map", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"type":  "dashboard_by_uid",
			"value": "AAbbCCdd",
		}, entries[2], "an initialized but empty map must serialize exactly as a nil one does")
		assert.NotContains(t, entries[2], "variables", "an empty map must not add a variables key")
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Equal(t, map[string]any{
			"type":  "dashboard_by_tag",
			"value": "graph-ng",
		}, entries[3], "a variable-less item must serialize exactly as it did before this field existed")
		assert.NotContains(t, entries[3], "variables", "a nil map must not add a variables key")
	})
}

// dashboardItems returns count minimal, variable-less items.
func dashboardItems(count int) []PlaylistItem {
	items := make([]PlaylistItem, count)
	for i := range items {
		items[i] = PlaylistItem{Type: "dashboard_by_uid", Value: "xCmMwXdVz"}
	}
	return items
}

// itemWithVariables returns a single-item list carrying exactly the given variables.
func itemWithVariables(variables map[string][]string) []PlaylistItem {
	return []PlaylistItem{{Type: "dashboard_by_uid", Value: "xCmMwXdVz", Variables: variables}}
}

// distinctVariables returns count single-valued variables under distinct names.
func distinctVariables(count int) map[string][]string {
	variables := make(map[string][]string, count)
	for i := range count {
		variables[fmt.Sprintf("host-%d", i)] = []string{"a"}
	}
	return variables
}

// distinctValues returns count distinct values for one variable.
func distinctValues(count int) []string {
	values := make([]string, count)
	for i := range values {
		values[i] = fmt.Sprintf("host-%d", i)
	}
	return values
}

func TestLegacyUpdateCommandToUnstructuredRejectsPayloadsOverTheBudget(t *testing.T) {
	longName := strings.Repeat("n", playlistapp.MaxVariableNameLength+1)
	longValue := strings.Repeat("v", playlistapp.MaxVariableValueLength+1)

	tests := []struct {
		name string
		// items is the only part of the command the budget applies to.
		items []PlaylistItem
		// errContains are substrings the aggregate message must carry: the field path and
		// the limit are what makes a 400 actionable.
		errContains []string
		// errNotContains guards the amplification rule: an over-long name or value must
		// never be echoed back inside the error that rejects it.
		errNotContains []string
	}{
		{
			name:        "more items than the maximum",
			items:       dashboardItems(playlistapp.MaxPlaylistItems + 1),
			errContains: []string{"items", "must have at most 1000 items"},
		},
		{
			name:        "more variables than the maximum",
			items:       itemWithVariables(distinctVariables(playlistapp.MaxItemVariables + 1)),
			errContains: []string{"items[0].variables", "must have at most 32 items"},
		},
		{
			name:        "more values than the maximum",
			items:       itemWithVariables(map[string][]string{"host": distinctValues(playlistapp.MaxVariableValues + 1)}),
			errContains: []string{"items[0].variables[host]", "must have at most 64 items"},
		},
		{
			name:           "variable name longer than the maximum",
			items:          itemWithVariables(map[string][]string{longName: {"a"}}),
			errContains:    []string{"items[0].variables", "may not be more than 128 characters"},
			errNotContains: []string{longName},
		},
		{
			name:           "variable value longer than the maximum",
			items:          itemWithVariables(map[string][]string{"host": {longValue}}),
			errContains:    []string{"items[0].variables[host][0]", "may not be more than 1024 characters"},
			errNotContains: []string{longValue},
		},
		{
			name:        "nil value list",
			items:       itemWithVariables(map[string][]string{"host": nil}),
			errContains: []string{"items[0].variables[host]", "at least one value"},
		},
		{
			name:        "empty value list",
			items:       itemWithVariables(map[string][]string{"host": {}}),
			errContains: []string{"items[0].variables[host]", "at least one value"},
		},
		{
			name:        "empty string element",
			items:       itemWithVariables(map[string][]string{"host": {"a", ""}}),
			errContains: []string{"items[0].variables[host][1]", "must not be empty"},
		},
		{
			name:        "empty variable name",
			items:       itemWithVariables(map[string][]string{"": {"a"}}),
			errContains: []string{"items[0].variables", "name is required"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			obj, err := LegacyUpdateCommandToUnstructured(UpdatePlaylistCommand{
				UID:      "playlist-uid",
				Name:     "Test",
				Interval: "20s",
				Items:    tc.items,
			})
			require.Error(t, err)
			for _, expected := range tc.errContains {
				assert.Contains(t, err.Error(), expected)
			}
			for _, forbidden := range tc.errNotContains {
				assert.NotContains(t, err.Error(), forbidden,
					"the rejection must not echo the value it rejects")
			}
			// A rejected payload is refused before anything is built, so the caller gets a
			// zero object rather than a partially converted one it could still write.
			assert.Equal(t, unstructured.Unstructured{}, obj,
				"nothing may be allocated for a payload that is refused")
		})
	}
}

func TestLegacyUpdateCommandToUnstructuredAcceptsTheBudgetLimits(t *testing.T) {
	// Every maximum is accepted exactly at the limit: an off-by-one in either direction is a
	// contract change, one that would either reject a valid playlist or let the next one grow.
	tests := []struct {
		name      string
		items     []PlaylistItem
		wantItems int
	}{
		{
			name:      "item count at the maximum",
			items:     dashboardItems(playlistapp.MaxPlaylistItems),
			wantItems: playlistapp.MaxPlaylistItems,
		},
		{
			name:      "variable count at the maximum",
			items:     itemWithVariables(distinctVariables(playlistapp.MaxItemVariables)),
			wantItems: 1,
		},
		{
			name:      "value count at the maximum",
			items:     itemWithVariables(map[string][]string{"host": distinctValues(playlistapp.MaxVariableValues)}),
			wantItems: 1,
		},
		{
			name: "variable name at the maximum length",
			items: itemWithVariables(map[string][]string{
				strings.Repeat("n", playlistapp.MaxVariableNameLength): {"a"},
			}),
			wantItems: 1,
		},
		{
			name: "variable value at the maximum length",
			items: itemWithVariables(map[string][]string{
				"host": {strings.Repeat("v", playlistapp.MaxVariableValueLength)},
			}),
			wantItems: 1,
		},
		{
			name:      "no items at all",
			items:     nil,
			wantItems: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			obj, err := LegacyUpdateCommandToUnstructured(UpdatePlaylistCommand{
				UID:      "playlist-uid",
				Name:     "Test",
				Interval: "20s",
				Items:    tc.items,
			})
			require.NoError(t, err)
			require.Equal(t, "playlist-uid", obj.GetName())
			items, found, err := unstructured.NestedSlice(obj.Object, "spec", "items")
			require.NoError(t, err)
			require.True(t, found)
			assert.Len(t, items, tc.wantItems)
		})
	}
}

func TestLegacyUpdateCommandToUnstructuredHappyPathIsUnchanged(t *testing.T) {
	// The accepted output is asserted as a whole here, so adding validation in front of the
	// conversion cannot quietly change the object the legacy endpoints write.
	obj, err := LegacyUpdateCommandToUnstructured(UpdatePlaylistCommand{
		UID:      "playlist-uid",
		Name:     "Test",
		Interval: "20s",
		Items: []PlaylistItem{
			{Type: "dashboard_by_uid", Value: "xCmMwXdVz", Variables: map[string][]string{"host": {"a", "b"}}},
			{Type: "dashboard_by_tag", Value: "graph-ng"},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, map[string]any{
		"metadata": map[string]any{
			"name": "playlist-uid",
		},
		"spec": map[string]any{
			"title":    "Test",
			"interval": "20s",
			"items": []any{
				map[string]any{
					"type":      "dashboard_by_uid",
					"value":     "xCmMwXdVz",
					"variables": map[string]any{"host": []any{"a", "b"}},
				},
				map[string]any{
					"type":  "dashboard_by_tag",
					"value": "graph-ng",
				},
			},
		},
	}, obj.Object)
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
						"type":      "dashboard_by_uid",
						"value":     "xCmMwXdVz",
						"variables": map[string]any{"host": []any{"z"}},
					},
					map[string]any{
						"type":      "dashboard_by_uid",
						"value":     "AAbbCCdd",
						"variables": map[string]any{},
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
	require.Len(t, dto.Items, 4, "every stored item must decode, in order")

	t.Run("item with several variables", func(t *testing.T) {
		assert.Equal(t, map[string][]string{
			"host":    {"a", "b"},
			"cluster": {"c"},
		}, dto.Items[0].Variables)

		assert.Equal(t, "dashboard_by_uid", dto.Items[0].Type)
		assert.Equal(t, "xCmMwXdVz", dto.Items[0].Value)
	})

	t.Run("repeated dashboard uid keeps its own variables", func(t *testing.T) {
		assert.Equal(t, "dashboard_by_uid", dto.Items[1].Type)
		assert.Equal(t, "xCmMwXdVz", dto.Items[1].Value)
		assert.Equal(t, dto.Items[0].Value, dto.Items[1].Value, "the fixture must list one uid twice")
		assert.Equal(t, map[string][]string{"host": {"z"}}, dto.Items[1].Variables,
			"two entries for the same dashboard must decode to their own variables, in order")
	})

	t.Run("item with an explicit empty variables map", func(t *testing.T) {
		// An empty JSON object allocates a map, which is what keeps it distinguishable from
		// the absent field below: only an absent (or null) field decodes to nil.
		require.NotNil(t, dto.Items[2].Variables, "an explicit empty object must decode to an allocated map")
		assert.Empty(t, dto.Items[2].Variables)
		assert.Equal(t, "dashboard_by_uid", dto.Items[2].Type)
		assert.Equal(t, "AAbbCCdd", dto.Items[2].Value)
	})

	t.Run("item without variables", func(t *testing.T) {
		assert.Nil(t, dto.Items[3].Variables, "an item without variables must decode to a nil map")
		assert.Equal(t, "dashboard_by_tag", dto.Items[3].Type)
		assert.Equal(t, "graph-ng", dto.Items[3].Value)
	})
}
