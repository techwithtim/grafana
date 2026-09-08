package playlist

import (
	"list"
	"strings"
)

// Shared item definition for all versions
#PlaylistItem: {
	type: "dashboard_by_tag" | "dashboard_by_uid" | "dashboard_by_id"
	// Value depends on type and describes the playlist item.
	//  - dashboard_by_id: The value is an internal numerical identifier set by Grafana. This
	//  is not portable as the numerical identifier is non-deterministic between different instances.
	//  Will be replaced by dashboard_by_uid in the future. (deprecated)
	//  - dashboard_by_tag: The value is a tag which is set on any number of dashboards. All
	//  dashboards behind the tag will be added to the playlist.
	//  - dashboard_by_uid: The value is the dashboard UID
	value: string
	// Optional template variable values applied when this item is played (dashboard_by_uid only).
	// Each key is a variable name; its value is a list of one or more values for that variable.
	// A multi-value variable is expressed by several list elements under the same key.
	// The collection is bounded, because every value is expanded into a dashboard URL and into the
	// editor's controls: an item accepts at most 32 variables, a variable name of at most 128
	// characters, and at most 64 values of at most 1024 characters each. A character means one
	// Unicode code point everywhere the limit is applied. The last two maxima are part of this
	// schema; the first two are enforced on every write, which is the only place this schema
	// language can express them.
	variables?: [string]: list.MaxItems(64) & [string & strings.MaxRunes(1024), ...(string & strings.MaxRunes(1024))]
}

playlistv1: {
	kind:       "Playlist"
	plural:     "playlists"
	scope:      "Namespaced"
	conversion: true
	validation: {
		operations: [
			"CREATE",
			"UPDATE",
		]
	}
	mutation: {
		operations: [
			"CREATE",
			"UPDATE",
		]
	}
	schema: {
		#Item: #PlaylistItem
		spec: {
			title:    string
			interval: string
			// The list is bounded: every viewer that plays the playlist walks all of it, loading a
			// dashboard and pushing a history entry for each item.
			items: list.MaxItems(1000) & [...#Item]
		}
	}
}
