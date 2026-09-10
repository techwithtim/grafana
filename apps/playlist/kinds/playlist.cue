package playlist

// Shared item definition for all versions
#PlaylistItem: {
	// type of the item.
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
	// A write is rejected when an item carries more than 32 variables, a variable carries more
	// than 64 values, a name is longer than 128 Unicode code points, a value is longer than 1024
	// Unicode code points, or a name or value is empty. A name of whitespace, invisible or
	// control characters alone counts as empty.
	variables?: [string]: [string, ...string]
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
	// items references #PlaylistItem directly on purpose. An intermediate alias
	// (#Item: #PlaylistItem) publishes a $ref-only OpenAPI model with no type of its
	// own, which structured-merge-diff cannot resolve: server-side apply then fails
	// and managedFields cannot be tracked for any playlist that has items.

	schema: {
		spec: {
			title:    string
			interval: string
			items: [...#PlaylistItem]
		}
	}
}
