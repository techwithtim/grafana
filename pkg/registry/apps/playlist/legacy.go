package playlist

// Playlist model
type Playlist struct {
	Id       int64  `json:"id,omitempty" db:"id"`
	UID      string `json:"uid" xorm:"uid" db:"uid"`
	Name     string `json:"name" db:"name"`
	Interval string `json:"interval" db:"interval"`
	OrgId    int64  `json:"-" db:"org_id"`

	// Unix timestamps avoid driver-specific time handling in the legacy migration path.
	CreatedAt int64 `json:"-" db:"created_at"`
	UpdatedAt int64 `json:"-" db:"updated_at"`
}

type PlaylistDTO struct {
	// Unique playlist identifier. Generated on creation, either by the
	// creator of the playlist of by the application.
	Uid string `json:"uid" db:"uid"`

	// Name of the playlist.
	Name string `json:"name"`

	// Interval sets the time between switching views in a playlist.
	Interval string `json:"interval"`

	// The ordered list of items that the playlist will iterate over.
	Items []PlaylistItemDTO `json:"items"`

	CreatedAt int64 `json:"-" db:"created_at"`
	UpdatedAt int64 `json:"-" db:"updated_at"`
	OrgID     int64 `json:"-" db:"org_id"`

	// The legacy ID is carried in the deprecated internal-ID annotation and omitted from JSON.
	Id int64 `json:"-" db:"id"`
}

type PlaylistItemDTO struct {
	// Title is an unused property -- it will be removed in the future
	Title *string `json:"title,omitempty"`

	// Type of the item.
	Type string `json:"type"`

	// Value depends on type and describes the playlist item.
	//
	//  - dashboard_by_id: The value is an internal numerical identifier set by Grafana. This
	//  is not portable as the numerical identifier is non-deterministic between different instances.
	//  Will be replaced by dashboard_by_uid in the future. (deprecated)
	//  - dashboard_by_tag: The value is a tag which is set on any number of dashboards. All
	//  dashboards behind the tag will be added to the playlist.
	//  - dashboard_by_uid: The value is the dashboard UID
	Value string `json:"value"`

	// Optional template variable values applied when this item is played (dashboard_by_uid only)
	Variables map[string][]string `json:"variables,omitempty"`
}

type PlaylistItem struct {
	Id         int64  `db:"id"`
	PlaylistId int64  `db:"playlist_id"`
	Type       string `json:"type" db:"type"`
	Value      string `json:"value" db:"value"`
	// Optional template variable values applied when this item is played (dashboard_by_uid only)
	Variables map[string][]string `json:"variables,omitempty" xorm:"-" db:"-"` // the obsolete playlist_item table has no variables column
	Order     int                 `json:"order" db:"order"`
	Title     string              `json:"title" db:"title"`
}

type Playlists []*Playlist

type UpdatePlaylistCommand struct {
	OrgId    int64          `json:"-"`
	UID      string         `json:"uid"`
	Name     string         `json:"name" binding:"Required"`
	Interval string         `json:"interval"`
	Items    []PlaylistItem `json:"items"`
}

type CreatePlaylistCommand struct {
	Name     string         `json:"name" binding:"Required"`
	Interval string         `json:"interval"`
	Items    []PlaylistItem `json:"items"`
	OrgId    int64          `json:"-"`
	// Used to create playlists from kubectl with a known uid/name
	UID string `json:"-"`
}

type DeletePlaylistCommand struct {
	UID   string
	OrgId int64
}

type GetPlaylistsQuery struct {
	Name  string
	Limit int
	OrgId int64
}

type GetPlaylistByUidQuery struct {
	UID   string
	OrgId int64
}

type GetPlaylistItemsByUidQuery struct {
	PlaylistUID string
	OrgId       int64
}
