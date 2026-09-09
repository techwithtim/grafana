package api

import (
	// The k8s helpers below already claim the "errors" identifier, so the standard
	// library package is aliased for the errors.As check in writeError.
	stderrors "errors"
	"fmt"
	"net/http"
	"strings"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/validate/content"
	v1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	playlistv1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
	"github.com/grafana/grafana/pkg/api/dtos"
	"github.com/grafana/grafana/pkg/api/routing"
	"github.com/grafana/grafana/pkg/apimachinery/errutil"
	"github.com/grafana/grafana/pkg/registry/apps/playlist"
	grafanaapiserver "github.com/grafana/grafana/pkg/services/apiserver"
	"github.com/grafana/grafana/pkg/services/apiserver/endpoints/request"
	contextmodel "github.com/grafana/grafana/pkg/services/contexthandler/model"
	"github.com/grafana/grafana/pkg/util/errhttp"
	"github.com/grafana/grafana/pkg/web"
)

func (hs *HTTPServer) registerPlaylistAPI(apiRoute routing.RouteRegister) {
	// Register the actual handlers
	// Deprecated: use /apis/playlist.grafana.app/ instead
	apiRoute.Group("/playlists", func(playlistRoute routing.RouteRegister) {
		// Use k8s client to implement legacy API
		handler := newPlaylistK8sHandler(hs)
		playlistRoute.Get("/", handler.searchPlaylists)
		playlistRoute.Get("/:uid", handler.getPlaylist)
		playlistRoute.Get("/:uid/items", handler.getPlaylistItems)
		playlistRoute.Delete("/:uid", handler.deletePlaylist)
		playlistRoute.Put("/:uid", handler.updatePlaylist)
		playlistRoute.Post("/", handler.createPlaylist)
	})
}

// swagger:parameters searchPlaylists
type SearchPlaylistsParams struct {
	// in:query
	// required:false
	Query string `json:"query"`
	// in:limit
	// required:false
	Limit int `json:"limit"`
}

// swagger:parameters getPlaylist
type GetPlaylistParams struct {
	// in:path
	// required:true
	UID string `json:"uid"`
}

// swagger:parameters getPlaylistItems
type GetPlaylistItemsParams struct {
	// in:path
	// required:true
	UID string `json:"uid"`
}

// swagger:parameters getPlaylistDashboards
type GetPlaylistDashboardsParams struct {
	// in:path
	// required:true
	UID string `json:"uid"`
}

// swagger:parameters deletePlaylist
type DeletePlaylistParams struct {
	// in:path
	// required:true
	UID string `json:"uid"`
}

// swagger:parameters updatePlaylist
type UpdatePlaylistParams struct {
	// in:body
	// required:true
	Body playlist.UpdatePlaylistCommand
	// in:path
	// required:true
	UID string `json:"uid"`
}

// swagger:parameters createPlaylist
type CreatePlaylistParams struct {
	// in:body
	// required:true
	Body playlist.CreatePlaylistCommand
}

// swagger:response searchPlaylistsResponse
type SearchPlaylistsResponse struct {
	// The response message
	// in: body
	Body playlist.Playlists `json:"body"`
}

// swagger:response getPlaylistResponse
type GetPlaylistResponse struct {
	// The response message
	// in: body
	Body *playlist.PlaylistDTO `json:"body"`
}

// swagger:response getPlaylistItemsResponse
type GetPlaylistItemsResponse struct {
	// The response message
	// in: body
	Body []playlist.PlaylistItemDTO `json:"body"`
}

// swagger:response getPlaylistDashboardsResponse
type GetPlaylistDashboardsResponse struct {
	// The response message
	// in: body
	Body dtos.PlaylistDashboardsSlice `json:"body"`
}

// swagger:response updatePlaylistResponse
type UpdatePlaylistResponse struct {
	// The response message
	// in: body
	Body *playlist.PlaylistDTO `json:"body"`
}

// swagger:response createPlaylistResponse
type CreatePlaylistResponse struct {
	// The response message
	// in: body
	Body *playlist.Playlist `json:"body"`
}

type playlistK8sHandler struct {
	namespacer           request.NamespaceMapper
	gvr                  schema.GroupVersionResource
	clientConfigProvider grafanaapiserver.DirectRestConfigProvider
}

//-----------------------------------------------------------------------------------------
// Playlist k8s wrapper functions
//-----------------------------------------------------------------------------------------

func newPlaylistK8sHandler(hs *HTTPServer) *playlistK8sHandler {
	return &playlistK8sHandler{
		gvr:                  playlistv1.PlaylistKind().GroupVersionResource(),
		namespacer:           request.GetNamespaceMapper(hs.Cfg),
		clientConfigProvider: hs.clientConfigProvider,
	}
}

// swagger:route GET /playlists playlists searchPlaylists
//
// Get playlists.
//
// Please refer to [new API](?api=playlist.grafana.app-v1).
//
// Deprecated: true
//
// Responses:
// 200: searchPlaylistsResponse
// 500: internalServerError
func (pk8s *playlistK8sHandler) searchPlaylists(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	out, err := client.List(c.Req.Context(), v1.ListOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}

	query := strings.ToUpper(c.Query("query"))
	playlists := []playlist.Playlist{}
	for _, item := range out.Items {
		p := playlist.UnstructuredToLegacyPlaylist(item)
		if p == nil {
			continue
		}
		if query != "" && !strings.Contains(strings.ToUpper(p.Name), query) {
			continue // query filter
		}
		playlists = append(playlists, *p)
	}
	c.JSON(http.StatusOK, playlists)
}

// swagger:route GET /playlists/{uid} playlists getPlaylist
//
// Get playlist.
//
// Please refer to [new API](?api=playlist.grafana.app-v1).
//
// Deprecated: true
//
// Responses:
// 200: getPlaylistResponse
// 401: unauthorisedError
// 403: forbiddenError
// 404: notFoundError
// 500: internalServerError
func (pk8s *playlistK8sHandler) getPlaylist(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	uid, ok := pk8s.playlistUID(c)
	if !ok {
		return // error is already sent
	}
	out, err := client.Get(c.Req.Context(), uid, v1.GetOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, playlist.UnstructuredToLegacyPlaylistDTO(*out))
}

// swagger:route GET /playlists/{uid}/items playlists getPlaylistItems
//
// Get playlist items.
//
// Please refer to [new API](?api=playlist.grafana.app-v1) instead (items are included in the playlist spec).
//
// Deprecated: true
//
// Responses:
// 200: getPlaylistItemsResponse
// 401: unauthorisedError
// 403: forbiddenError
// 404: notFoundError
// 500: internalServerError
func (pk8s *playlistK8sHandler) getPlaylistItems(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	uid, ok := pk8s.playlistUID(c)
	if !ok {
		return // error is already sent
	}
	out, err := client.Get(c.Req.Context(), uid, v1.GetOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, playlist.UnstructuredToLegacyPlaylistDTO(*out).Items)
}

// swagger:route DELETE /playlists/{uid} playlists deletePlaylist
//
// Delete playlist.
//
// Please refer to [new API](?api=playlist.grafana.app-v1).
//
// Deprecated: true
//
// Responses:
// 200: okResponse
// 401: unauthorisedError
// 403: forbiddenError
// 404: notFoundError
// 500: internalServerError
func (pk8s *playlistK8sHandler) deletePlaylist(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	uid, ok := pk8s.playlistUID(c)
	if !ok {
		return // error is already sent
	}
	err := client.Delete(c.Req.Context(), uid, v1.DeleteOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, "")
}

// swagger:route PUT /playlists/{uid} playlists updatePlaylist
//
// Update playlist.
//
// Please refer to [new API](?api=playlist.grafana.app-v1).
//
// Deprecated: true
//
// Responses:
// 200: updatePlaylistResponse
// 401: unauthorisedError
// 403: forbiddenError
// 404: notFoundError
// 500: internalServerError
func (pk8s *playlistK8sHandler) updatePlaylist(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	uid, ok := pk8s.playlistUID(c)
	if !ok {
		return // error is already sent
	}
	cmd := playlist.UpdatePlaylistCommand{}
	if err := web.Bind(c.Req, &cmd); err != nil {
		c.JsonApiErr(http.StatusBadRequest, "bad request data", err)
		return
	}
	obj := playlist.LegacyUpdateCommandToUnstructured(cmd)
	obj.SetName(uid)
	existing, err := client.Get(c.Req.Context(), uid, v1.GetOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	obj.SetResourceVersion(existing.GetResourceVersion())
	out, err := client.Update(c.Req.Context(), &obj, v1.UpdateOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, playlist.UnstructuredToLegacyPlaylistDTO(*out))
}

// swagger:route POST /playlists playlists createPlaylist
//
// Create playlist.
//
// Please refer to [new API](?api=playlist.grafana.app-v1).
//
// Deprecated: true
//
// Responses:
// 200: createPlaylistResponse
// 401: unauthorisedError
// 403: forbiddenError
// 404: notFoundError
// 500: internalServerError
func (pk8s *playlistK8sHandler) createPlaylist(c *contextmodel.ReqContext) {
	client, ok := pk8s.getClient(c)
	if !ok {
		return // error is already sent
	}
	cmd := playlist.UpdatePlaylistCommand{}
	if err := web.Bind(c.Req, &cmd); err != nil {
		c.JsonApiErr(http.StatusBadRequest, "bad request data", err)
		return
	}
	// The uid arrives in the body here rather than in the path, so it needs the same
	// pre-flight check the uid-bearing handlers get. An empty body uid is legitimate:
	// LegacyUpdateCommandToUnstructured generates a short uid for it.
	if cmd.UID != "" {
		if err := validatePlaylistUID(cmd.UID); err != nil {
			c.JsonApiErr(http.StatusBadRequest, invalidPlaylistUIDMessage, err)
			return
		}
	}
	obj := playlist.LegacyUpdateCommandToUnstructured(cmd)
	out, err := client.Create(c.Req.Context(), &obj, v1.CreateOptions{})
	if err != nil {
		pk8s.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, playlist.UnstructuredToLegacyPlaylistDTO(*out))
}

//-----------------------------------------------------------------------------------------
// Utility functions
//-----------------------------------------------------------------------------------------

func (pk8s *playlistK8sHandler) getClient(c *contextmodel.ReqContext) (dynamic.ResourceInterface, bool) {
	// NOTE! if you are copying this, consider using the hs.clientclientGenerator to get a typed client!
	dyn, err := dynamic.NewForConfig(pk8s.clientConfigProvider.GetDirectRestConfig(c))
	if err != nil {
		c.JsonApiErr(500, "client", err)
		return nil, false
	}
	return dyn.Resource(pk8s.gvr).Namespace(pk8s.namespacer(c.OrgID)), true
}

// invalidPlaylistUIDMessage is the only detail a caller gets back for a uid that
// cannot address a playlist. The uid itself and the validator's own wording stay
// out of the response body so nothing user-controlled is reflected back; both are
// carried by the error passed to JsonApiErr, which logs them server-side.
const invalidPlaylistUIDMessage = "invalid playlist uid"

// playlistUID reads the :uid path parameter and rejects anything the API server
// client would refuse to put in a request path. Pre-validating here matters because
// client-go performs the same check itself (rest.Request.Name) and fails with a plain
// error that carries no k8s Status: it would reach writeError's fallback and answer
// 500 in an envelope no other legacy playlist error uses. Rejecting it up front keeps
// this deprecated surface answering 400 in the standard {message, traceID} envelope,
// and it never reaches the API server with an unusable name.
//
// The second return value follows the getClient convention: false means the error
// response has already been written and the handler must return immediately.
func (pk8s *playlistK8sHandler) playlistUID(c *contextmodel.ReqContext) (string, bool) {
	uid := web.Params(c.Req)[":uid"]
	if err := validatePlaylistUID(uid); err != nil {
		// The error must be non-nil: JsonApiErr only adds the traceID key when one is
		// passed, and every other legacy playlist error carries traceID.
		c.JsonApiErr(http.StatusBadRequest, invalidPlaylistUIDMessage, err)
		return "", false
	}
	return uid, true
}

// validatePlaylistUID mirrors the resource-name rules the API server client enforces
// on a path segment: a name is required, may not be "." or "..", and may not contain
// "/" or "%" (content.IsPathSegmentName, which the client itself uses, deliberately
// does not check for the empty string).
func validatePlaylistUID(uid string) error {
	if uid == "" {
		return stderrors.New("playlist uid is required")
	}
	if msgs := content.IsPathSegmentName(uid); len(msgs) > 0 {
		return fmt.Errorf("invalid playlist uid %q: %s", uid, strings.Join(msgs, ", "))
	}
	return nil
}

func (pk8s *playlistK8sHandler) writeError(c *contextmodel.ReqContext, err error) {
	//nolint:errorlint
	statusError, ok := err.(*errors.StatusError)
	if ok {
		c.JsonApiErr(int(statusError.Status().Code), statusError.Status().Message, err)
		return
	}
	// errhttp.Write is kept only for errors that really are errutil errors, because
	// those carry a deliberate status and public payload. Everything else (a request
	// the client refused to build, a transport failure) would hit errhttp's
	// ErrNonGrafanaError fallback and be written as 500 {statusCode, messageId,
	// message} -- a second envelope shape on a surface whose every other error is
	// {message, traceID}. Those go through JsonApiErr instead to keep one envelope.
	var grafanaErr errutil.Error
	if stderrors.As(err, &grafanaErr) {
		errhttp.Write(c.Req.Context(), err, c.Resp)
		return
	}
	c.JsonApiErr(http.StatusInternalServerError, "playlist request failed", err)
}
