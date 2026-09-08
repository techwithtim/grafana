package playlist

import (
	"encoding/json"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/grafana/grafana/pkg/apimachinery/utils"
	"github.com/grafana/grafana/pkg/util"
)

func LegacyUpdateCommandToUnstructured(cmd UpdatePlaylistCommand) unstructured.Unstructured {
	// Unstructured content must only hold JSON-compatible values: apimachinery walks it with
	// runtime.DeepCopyJSONValue, which understands []any and map[string]any and panics on any
	// other container -- a []map[string]any item list included. Both the item list and the
	// typed map of string slices inside it are therefore converted all the way down.
	items := make([]any, 0, len(cmd.Items))
	for _, item := range cmd.Items {
		entry := map[string]any{
			"type":  item.Type,
			"value": item.Value,
		}
		if len(item.Variables) > 0 {
			variables := make(map[string]any, len(item.Variables))
			for name, values := range item.Variables {
				encoded := make([]any, 0, len(values))
				for _, value := range values {
					encoded = append(encoded, value)
				}
				variables[name] = encoded
			}
			entry["variables"] = variables
		}
		items = append(items, entry)
	}
	obj := unstructured.Unstructured{
		Object: map[string]interface{}{
			"spec": map[string]interface{}{
				"title":    cmd.Name,
				"interval": cmd.Interval,
				"items":    items,
			},
		},
	}
	if cmd.UID == "" {
		cmd.UID = util.GenerateShortUID()
	}
	obj.SetName(cmd.UID)
	return obj
}

func UnstructuredToLegacyPlaylist(item unstructured.Unstructured) *Playlist {
	spec := item.Object["spec"].(map[string]any)
	return &Playlist{
		UID:      item.GetName(),
		Name:     spec["title"].(string),
		Interval: spec["interval"].(string),
		Id:       getLegacyID(&item),
	}
}

func UnstructuredToLegacyPlaylistDTO(item unstructured.Unstructured) *PlaylistDTO {
	spec := item.Object["spec"].(map[string]any)
	dto := &PlaylistDTO{
		Uid:      item.GetName(),
		Name:     spec["title"].(string),
		Interval: spec["interval"].(string),
		Id:       getLegacyID(&item),
	}
	items := spec["items"]
	if items != nil {
		b, err := json.Marshal(items)
		if err == nil {
			_ = json.Unmarshal(b, &dto.Items)
		}
	}
	return dto
}

// Read legacy ID from metadata annotations
func getLegacyID(item *unstructured.Unstructured) int64 {
	meta, err := utils.MetaAccessor(item)
	if err != nil {
		return 0
	}
	return meta.GetDeprecatedInternalID() // nolint:staticcheck
}
