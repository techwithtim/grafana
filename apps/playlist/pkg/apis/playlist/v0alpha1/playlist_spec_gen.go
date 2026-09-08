// Code generated - EDITING IS FUTILE. DO NOT EDIT.

package v0alpha1

// +k8s:openapi-gen=true
type PlaylistItem = PlaylistPlaylistItem

// NewPlaylistItem creates a new PlaylistItem object.
func NewPlaylistItem() *PlaylistItem {
	return NewPlaylistPlaylistItem()
}

// Shared item definition for all versions
// +k8s:openapi-gen=true
type PlaylistPlaylistItem struct {
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
	// The collection is bounded, because every value is expanded into a dashboard URL and into the
	// editor's controls: an item accepts at most 32 variables, a variable name of at most 128
	// characters, and at most 64 values of at most 1024 characters each. A character means one
	// Unicode code point everywhere the limit is applied. The last two maxima are part of this
	// schema; the first two are enforced on every write, which is the only place this schema
	// language can express them.
	Variables map[string][]string `json:"variables,omitempty"`
}

// NewPlaylistPlaylistItem creates a new PlaylistPlaylistItem object.
func NewPlaylistPlaylistItem() *PlaylistPlaylistItem {
	return &PlaylistPlaylistItem{}
}

// OpenAPIModelName returns the OpenAPI model name for PlaylistPlaylistItem.
func (PlaylistPlaylistItem) OpenAPIModelName() string {
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v0alpha1.PlaylistPlaylistItem"
}

// +k8s:openapi-gen=true
type PlaylistSpec struct {
	Title    string `json:"title"`
	Interval string `json:"interval"`
	// The list is bounded: every viewer that plays the playlist walks all of it, loading a
	// dashboard and pushing a history entry for each item.
	Items []PlaylistItem `json:"items"`
}

// NewPlaylistSpec creates a new PlaylistSpec object.
func NewPlaylistSpec() *PlaylistSpec {
	return &PlaylistSpec{
		Items: []PlaylistItem{},
	}
}

// OpenAPIModelName returns the OpenAPI model name for PlaylistSpec.
func (PlaylistSpec) OpenAPIModelName() string {
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v0alpha1.PlaylistSpec"
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
	return "com.github.grafana.grafana.apps.playlist.pkg.apis.playlist.v0alpha1.PlaylistPlaylistItemType"
}
