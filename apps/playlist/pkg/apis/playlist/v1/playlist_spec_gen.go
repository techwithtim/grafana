// Code generated - EDITING IS FUTILE. DO NOT EDIT.

package v1

// Shared item definition for all versions
// +k8s:openapi-gen=true
type PlaylistPlaylistItem struct {
	// type of the item.
	Type PlaylistPlaylistItemType `json:"type"`
	// Value depends on type and describes the playlist item.
	//  - dashboard_by_id: The value is an internal numerical identifier set by Grafana. This
	//  is not portable as the numerical identifier is non-deterministic between different instances.
	//  Will be replaced by dashboard_by_uid in the future. (deprecated)
	//  - dashboard_by_tag: The value is a tag which is set on any number of dashboards. All
	//  dashboards behind the tag will be added to the playlist.
	//  - dashboard_by_uid: The value is the dashboard UID
	Value string `json:"value"`
	// Optional template variable values applied when this item is played (dashboard_by_uid only).
	// Each key is a variable name; its value is a list of one or more values for that variable.
	// A multi-value variable is expressed by several list elements under the same key.
	// A write is rejected when an item carries more than 32 variables, a variable carries more
	// than 64 values, a name is longer than 128 Unicode code points, a value is longer than 1024
	// Unicode code points, or a name or value is empty. A name of whitespace, invisible or
	// control characters alone counts as empty.
	Variables map[string][]string `json:"variables,omitempty"`
}

// NewPlaylistPlaylistItem creates a new PlaylistPlaylistItem object.
func NewPlaylistPlaylistItem() *PlaylistPlaylistItem {
	return &PlaylistPlaylistItem{}
}

// OpenAPIModelName returns the OpenAPI model name for PlaylistPlaylistItem.
func (PlaylistPlaylistItem) OpenAPIModelName() string {
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v1.PlaylistPlaylistItem"
}

// +k8s:openapi-gen=true
type PlaylistSpec struct {
	Title    string                 `json:"title"`
	Interval string                 `json:"interval"`
	Items    []PlaylistPlaylistItem `json:"items"`
}

// NewPlaylistSpec creates a new PlaylistSpec object.
func NewPlaylistSpec() *PlaylistSpec {
	return &PlaylistSpec{
		Items: []PlaylistPlaylistItem{},
	}
}

// OpenAPIModelName returns the OpenAPI model name for PlaylistSpec.
func (PlaylistSpec) OpenAPIModelName() string {
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v1.PlaylistSpec"
}

// +k8s:openapi-gen=true
type PlaylistPlaylistItemType string

const (
	PlaylistPlaylistItemTypeDashboardByTag PlaylistPlaylistItemType = "dashboard_by_tag"
	PlaylistPlaylistItemTypeDashboardByUid PlaylistPlaylistItemType = "dashboard_by_uid"
	PlaylistPlaylistItemTypeDashboardById  PlaylistPlaylistItemType = "dashboard_by_id"
)

// OpenAPIModelName returns the OpenAPI model name for PlaylistPlaylistItemType.
func (PlaylistPlaylistItemType) OpenAPIModelName() string {
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v1.PlaylistPlaylistItemType"
}
