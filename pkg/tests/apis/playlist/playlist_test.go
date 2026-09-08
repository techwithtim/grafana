package playlist

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	playlistapp "github.com/grafana/grafana/apps/playlist/pkg/app"
	playlist "github.com/grafana/grafana/pkg/registry/apps/playlist"
	"github.com/grafana/grafana/pkg/services/accesscontrol"
	"github.com/grafana/grafana/pkg/services/org"
	"github.com/grafana/grafana/pkg/services/sqlstore"
	"github.com/grafana/grafana/pkg/tests/apis"
	"github.com/grafana/grafana/pkg/tests/testinfra"
	"github.com/grafana/grafana/pkg/tests/testsuite"
	"github.com/grafana/grafana/pkg/util/testutil"
)

func TestMain(m *testing.M) {
	testsuite.Run(m)
}

var gvr = schema.GroupVersionResource{
	Group:    "playlist.grafana.app",
	Version:  "v1",
	Resource: "playlists",
}

var RESOURCEGROUP = gvr.GroupResource().String()

func TestIntegrationPlaylist(t *testing.T) {
	testutil.SkipIntegrationTestInShortMode(t)

	t.Run("default setup", func(t *testing.T) {
		h := doPlaylistTests(t, apis.NewK8sTestHelper(t, testinfra.GrafanaOpts{
			AppModeProduction:    true, // do not start extra port 6443
			DisableAnonymous:     true,
			EnableFeatureToggles: []string{"playlistsRBAC"},
		}))

		disco, err := h.GetGroupVersionInfoJSON("playlist.grafana.app")
		require.NoError(t, err)
		require.JSONEq(t, `[
          {
            "freshness": "Current",
            "resources": [
              {
                "resource": "playlists",
                "responseKind": {
                  "group": "",
                  "kind": "Playlist",
                  "version": ""
                },
                "scope": "Namespaced",
                "singularResource": "playlist",
                "subresources": [
                  {
                    "responseKind": {
                      "group": "",
                      "kind": "Playlist",
                      "version": ""
                    },
                    "subresource": "status",
                    "verbs": [
                      "get",
                      "patch",
                      "update"
                    ]
                  }
                ],
                "verbs": [
                  "create",
                  "delete",
                  "deletecollection",
                  "get",
                  "list",
                  "patch",
                  "update",
                  "watch"
                ]
              }
            ],
            "version": "v1"
          },
		  {
            "freshness": "Current",
            "resources": [
              {
                "resource": "playlists",
                "responseKind": {
                  "group": "",
                  "kind": "Playlist",
                  "version": ""
                },
                "scope": "Namespaced",
                "singularResource": "playlist",
                "subresources": [
                  {
                    "responseKind": {
                      "group": "",
                      "kind": "Playlist",
                      "version": ""
                    },
                    "subresource": "status",
                    "verbs": [
                      "get",
                      "patch",
                      "update"
                    ]
                  }
                ],
                "verbs": [
                  "create",
                  "delete",
                  "deletecollection",
                  "get",
                  "list",
                  "patch",
                  "update",
                  "watch"
                ]
              }
            ],
            "version": "v0alpha1"
          }
        ]`, disco)
	})
}

func doPlaylistTests(t *testing.T, helper *apis.K8sTestHelper) *apis.K8sTestHelper {
	t.Run("Check direct List permissions from different org users", func(t *testing.T) {
		rsp := helper.List(helper.Org1.Viewer, "default", gvr)
		require.Equal(t, 200, rsp.Response.StatusCode)
		require.NotNil(t, rsp.Result)
		require.Empty(t, rsp.Result.Items)
		require.Nil(t, rsp.Status)

		rsp = helper.List(helper.OrgB.Viewer, "default", gvr)
		require.Equal(t, 403, rsp.Response.StatusCode) // OrgB cannot access Org1's default namespace
		require.Nil(t, rsp.Result)
		require.Equal(t, metav1.StatusReasonForbidden, rsp.Status.Reason)

		rsp = helper.List(helper.OrgB.Viewer, "org-22", gvr)
		require.Equal(t, 403, rsp.Response.StatusCode) // org-22 is not an organization this user is a member of
		require.Nil(t, rsp.Result)
		require.Equal(t, metav1.StatusReasonForbidden, rsp.Status.Reason)
	})

	t.Run("Check CRUD operations with None role", func(t *testing.T) {
		clientAdmin := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Admin,
			GVR:  gvr,
		})
		created, err := clientAdmin.Resource.Create(context.Background(),
			helper.LoadYAMLOrJSONFile("testdata/playlist-generate.yaml"),
			metav1.CreateOptions{},
		)
		require.NoError(t, err)
		t.Cleanup(func() {
			_ = clientAdmin.Resource.Delete(context.Background(), created.GetName(), metav1.DeleteOptions{})
		})

		clientNone := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.None,
			GVR:  gvr,
		})

		t.Run("None role denied by default", func(t *testing.T) {
			_, err = clientNone.Resource.Get(context.Background(), created.GetName(), metav1.GetOptions{})
			require.Error(t, err)

			_, err = clientNone.Resource.List(context.Background(), metav1.ListOptions{})
			require.Error(t, err)

			_, err = clientNone.Resource.Create(context.Background(),
				helper.LoadYAMLOrJSONFile("testdata/playlist-generate.yaml"),
				metav1.CreateOptions{},
			)
			require.Error(t, err)

			_, err = clientNone.Resource.Update(context.Background(), created, metav1.UpdateOptions{})
			require.Error(t, err)

			err = clientNone.Resource.Delete(context.Background(), created.GetName(), metav1.DeleteOptions{})
			require.Error(t, err)
		})

		// The permission is granted through a fresh user and a managed: role name because
		// GetUserPermissions filters by OSSRolesPrefixes = ["managed:", "extsvc:"], and the
		// generic AddUserPermissionToDB helper uses "test:role", which is silently filtered out.
		t.Run("None role with explicit playlists:read can read but not write", func(t *testing.T) {
			noneWithRead := helper.CreateUser("none-with-read", apis.Org1, org.RoleNone, nil)
			noneUserID, err := noneWithRead.Identity.GetInternalID()
			require.NoError(t, err)

			orgID := noneWithRead.Identity.GetOrgID()
			err = helper.GetEnv().SQLStore.WithDbSession(context.Background(), func(sess *sqlstore.DBSession) error {
				roleName := accesscontrol.ManagedUserRoleName(noneUserID)
				role := &accesscontrol.Role{
					OrgID:   orgID,
					UID:     fmt.Sprintf("managed_user_%d_permissions", noneUserID),
					Name:    roleName,
					Updated: time.Now(),
					Created: time.Now(),
				}
				if _, err := sess.Insert(role); err != nil {
					return err
				}
				if _, err := sess.Insert(accesscontrol.UserRole{
					OrgID:   orgID,
					RoleID:  role.ID,
					UserID:  noneUserID,
					Created: time.Now(),
				}); err != nil {
					return err
				}
				perm := accesscontrol.Permission{
					RoleID:  role.ID,
					Action:  playlist.ActionPlaylistsRead,
					Scope:   "playlists:*",
					Created: time.Now(),
					Updated: time.Now(),
				}
				perm.Kind, perm.Attribute, perm.Identifier = perm.SplitScope()
				_, err := sess.Insert(&perm)
				return err
			})
			require.NoError(t, err)

			clientNoneWithRead := helper.GetResourceClient(apis.ResourceClientArgs{
				User: noneWithRead,
				GVR:  gvr,
			})

			_, err = clientNoneWithRead.Resource.Get(context.Background(), created.GetName(), metav1.GetOptions{})
			require.NoError(t, err, "None user with playlists:read should be able to get a playlist")

			_, err = clientNoneWithRead.Resource.List(context.Background(), metav1.ListOptions{})
			require.NoError(t, err, "None user with playlists:read should be able to list playlists")

			_, err = clientNoneWithRead.Resource.Create(context.Background(),
				helper.LoadYAMLOrJSONFile("testdata/playlist-generate.yaml"),
				metav1.CreateOptions{},
			)
			require.Error(t, err, "None user with only playlists:read should not be able to create")

			_, err = clientNoneWithRead.Resource.Update(context.Background(), created, metav1.UpdateOptions{})
			require.Error(t, err, "None user with only playlists:read should not be able to update")

			err = clientNoneWithRead.Resource.Delete(context.Background(), created.GetName(), metav1.DeleteOptions{})
			require.Error(t, err, "None user with only playlists:read should not be able to delete")
		})
	})

	t.Run("Check k8s client-go List from different org users", func(t *testing.T) {
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User:      helper.Org1.Viewer,
			Namespace: "", // Empty resolves to the user's own organization namespace
			GVR:       gvr,
		})
		rsp, err := client.Resource.List(context.Background(), metav1.ListOptions{})
		require.NoError(t, err)
		require.Empty(t, rsp.Items)

		client = helper.GetResourceClient(apis.ResourceClientArgs{
			User:      helper.OrgB.Viewer,
			Namespace: "default", // The default namespace belongs to Org1
			GVR:       gvr,
		})
		rsp, err = client.Resource.List(context.Background(), metav1.ListOptions{})
		statusError := helper.AsStatusError(err)
		require.Nil(t, rsp)
		require.Equal(t, metav1.StatusReasonForbidden, statusError.Status().Reason)

		client = helper.GetResourceClient(apis.ResourceClientArgs{
			User:      helper.OrgB.Viewer,
			Namespace: "org-22", // org 22 does not exist
			GVR:       gvr,
		})
		rsp, err = client.Resource.List(context.Background(), metav1.ListOptions{})
		statusError = helper.AsStatusError(err)
		require.Nil(t, rsp)
		require.Equal(t, metav1.StatusReasonForbidden, statusError.Status().Reason)
	})

	t.Run("Check playlist CRUD in legacy API appears in k8s apis", func(t *testing.T) {
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR:  gvr,
		})

		// Legacy clients may send dashboard metadata alongside each item; the bridge ignores it.
		legacyPayload := `{
			"name": "Test",
			"interval": "20s",
			"items": [
			  {
				"type": "dashboard_by_uid",
				"value": "xCmMwXdVz",
				"dashboards": [
				  {
					"name": "The dashboard",
					"kind": "dashboard",
					"uid": "xCmMwXdVz",
					"url": "/d/xCmMwXdVz/barchart-label-rotation-and-skipping",
					"tags": ["barchart", "gdev", "graph-ng", "panel-tests"],
					"location": "d1de6240-fd2e-4e13-99b6-f9d0c6b0550d"
				  }
				]
			  },
			  {
				"type": "dashboard_by_tag",
				"value": "graph-ng",
				"dashboards": [ "..." ]
			  }
			],
			"uid": ""
		  }`
		legacyCreate := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodPost,
			Path:   "/api/playlists",
			Body:   []byte(legacyPayload),
		}, &playlist.Playlist{})
		require.Equal(t, 200, legacyCreate.Response.StatusCode)
		require.NotNil(t, legacyCreate.Result)
		uid := legacyCreate.Result.UID
		require.NotEmpty(t, uid)

		expectedResult := `{
  "apiVersion": "playlist.grafana.app/v1",
  "kind": "Playlist",
  "metadata": {
    "creationTimestamp": "${creationTimestamp}",
    "name": "` + uid + `",
    "namespace": "default",
    "resourceVersion": "${resourceVersion}",
    "uid": "${uid}"
  },
  "spec": {
    "interval": "20s",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "xCmMwXdVz"
      },
      {
        "type": "dashboard_by_tag",
        "value": "graph-ng"
      }
    ],
    "title": "Test"
  },
  "status": {}
}`

		k8sList, err := client.Resource.List(context.Background(), metav1.ListOptions{})
		require.NoError(t, err)
		require.Equal(t, 1, len(k8sList.Items))
		require.JSONEq(t, expectedResult, client.SanitizeJSON(&k8sList.Items[0], "labels"))

		found, err := client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
		require.NoError(t, err)
		require.JSONEq(t, expectedResult, client.SanitizeJSON(found, "labels"))

		// The legacy bodies below are compared as raw bytes, not with JSONEq, because they pin
		// the exact response an existing client already parses: raw equality also fixes field
		// order, the compact formatting and the single trailing newline, all of which JSONEq
		// ignores. This suite runs with AppModeProduction, so web.Context.JSON writes compact
		// JSON followed by that newline.
		expectedLegacyDTO := `{"uid":"` + uid + `","name":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz"},{"type":"dashboard_by_tag","value":"graph-ng"}]}` + "\n"
		require.Equal(t, expectedLegacyDTO, string(legacyCreate.Body))

		legacyGet := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + uid,
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, legacyGet.Response.StatusCode)
		require.Equal(t, expectedLegacyDTO, string(legacyGet.Body))

		legacyItems := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + uid + "/items",
		}, &[]playlist.PlaylistItemDTO{})
		require.Equal(t, 200, legacyItems.Response.StatusCode)
		require.Equal(t, `[{"type":"dashboard_by_uid","value":"xCmMwXdVz"},{"type":"dashboard_by_tag","value":"graph-ng"}]`+"\n", string(legacyItems.Body))

		updatedInterval := `"interval": "10m"`
		legacyPayload = strings.Replace(legacyPayload, `"interval": "20s"`, updatedInterval, 1)
		require.JSONEq(t, expectedResult, client.SanitizeJSON(&k8sList.Items[0], "labels"))
		dtoResponse := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodPut,
			Path:   "/api/playlists/" + uid,
			Body:   []byte(legacyPayload),
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, dtoResponse.Response.StatusCode)
		require.Equal(t, uid, dtoResponse.Result.Uid)
		require.Equal(t, "10m", dtoResponse.Result.Interval)

		// Only the interval changed: an update must not add keys to variable-less items.
		expectedLegacyDTOAfterUpdate := `{"uid":"` + uid + `","name":"Test","interval":"10m","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz"},{"type":"dashboard_by_tag","value":"graph-ng"}]}` + "\n"
		require.Equal(t, expectedLegacyDTOAfterUpdate, string(dtoResponse.Body))

		legacyGet = apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + uid,
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, legacyGet.Response.StatusCode)
		require.Equal(t, expectedLegacyDTOAfterUpdate, string(legacyGet.Body))

		expectedUnstructuredResult := &unstructured.Unstructured{
			Object: map[string]any{
				"apiVersion": "playlist.grafana.app/v1",
				"kind":       "Playlist",
				"metadata": map[string]any{
					"creationTimestamp": "123",
					"name":              uid,
					"namespace":         "default",
					"resourceVersion":   "123",
					"uid":               uid,
				},
				"spec": map[string]any{
					"interval": "10m",
					"items": []interface{}{
						map[string]any{
							"type":  "dashboard_by_uid",
							"value": "xCmMwXdVz",
						},
						map[string]any{
							"type":  "dashboard_by_tag",
							"value": "graph-ng",
						},
					},
					"title": "Test",
				},
				"status": map[string]any{},
			},
		}

		accExpected, err := meta.Accessor(expectedUnstructuredResult)
		require.NoError(t, err)
		expectedSpec, _, err := unstructured.NestedMap(expectedUnstructuredResult.Object, "spec")
		require.NoError(t, err)

		found, err = client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
		require.NoError(t, err)
		foundSpec, _, err := unstructured.NestedMap(found.Object, "spec")
		require.NoError(t, err)

		require.Equal(t, accExpected.GetName(), found.GetName())
		require.Equal(t, expectedSpec, foundSpec)

		deleteResponse := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodDelete,
			Path:   "/api/playlists/" + uid,
			Body:   []byte(legacyPayload),
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, deleteResponse.Response.StatusCode)

		found, err = client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
		statusError := helper.AsStatusError(err)
		require.Nil(t, found)
		require.Equal(t, metav1.StatusReasonNotFound, statusError.Status().Reason)
	})

	// This runs after the legacy CRUD sub-test above because that one asserts the k8s List
	// returns exactly one playlist, so any object created here beforehand would break it.
	// Everything created below is removed by a t.Cleanup registered immediately after its
	// creation, which keeps the org-scoped List assertions in the sibling sub-tests valid.
	t.Run("Check playlist item variables round trip through legacy and k8s apis", func(t *testing.T) {
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR:  gvr,
		})

		// The same dashboard uid is listed twice on purpose, with a different variable set
		// each time: that is how one parameterized dashboard rotates through several hosts
		// within a single playlist.
		legacyPayload := `{
			"name": "With variables",
			"interval": "20s",
			"items": [
			  {
				"type": "dashboard_by_uid",
				"value": "xCmMwXdVz",
				"variables": { "host": ["a", "b"], "cluster": ["c"] }
			  },
			  {
				"type": "dashboard_by_uid",
				"value": "xCmMwXdVz",
				"variables": { "host": ["z"] }
			  },
			  {
				"type": "dashboard_by_tag",
				"value": "graph-ng"
			  }
			],
			"uid": ""
		  }`
		legacyCreate := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodPost,
			Path:   "/api/playlists",
			Body:   []byte(legacyPayload),
		}, &playlist.Playlist{})
		// Registered before the assertions below, not after them: those assertions are fatal,
		// so a create that succeeded on the server but answered with an unexpected body would
		// otherwise abort the sub-test with the object still in unified storage, breaking the
		// org-scoped List assertions in the sibling sub-tests. The closure reads the response
		// only when it runs, so it needs no uid derived by a fatal assertion and does nothing
		// when no object was created.
		t.Cleanup(func() {
			if legacyCreate.Result == nil || legacyCreate.Result.UID == "" {
				return
			}
			err := client.Resource.Delete(context.Background(), legacyCreate.Result.UID, metav1.DeleteOptions{})
			// An already-absent object is the expected outcome when the sub-test failed before
			// or during creation; anything else left the fixture behind and must be visible.
			if err != nil && !apierrors.IsNotFound(err) {
				t.Errorf("failed to clean up playlist %s: %v", legacyCreate.Result.UID, err)
			}
		})
		require.Equal(t, 200, legacyCreate.Response.StatusCode)
		require.NotNil(t, legacyCreate.Result)
		uid := legacyCreate.Result.UID
		require.NotEmpty(t, uid)

		expectedResult := `{
  "apiVersion": "playlist.grafana.app/v1",
  "kind": "Playlist",
  "metadata": {
    "creationTimestamp": "${creationTimestamp}",
    "name": "` + uid + `",
    "namespace": "default",
    "resourceVersion": "${resourceVersion}",
    "uid": "${uid}"
  },
  "spec": {
    "interval": "20s",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "xCmMwXdVz",
        "variables": {
          "cluster": ["c"],
          "host": ["a", "b"]
        }
      },
      {
        "type": "dashboard_by_uid",
        "value": "xCmMwXdVz",
        "variables": {
          "host": ["z"]
        }
      },
      {
        "type": "dashboard_by_tag",
        "value": "graph-ng"
      }
    ],
    "title": "With variables"
  },
  "status": {}
}`

		found, err := client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
		require.NoError(t, err)
		require.JSONEq(t, expectedResult, client.SanitizeJSON(found, "labels"))

		// The tag item must not carry the key at all -- not even as an empty or null value,
		// which would change the stored object of every playlist that uses no variables.
		storedItems, _, err := unstructured.NestedSlice(found.Object, "spec", "items")
		require.NoError(t, err)
		require.Len(t, storedItems, 3)
		storedTagItem, ok := storedItems[2].(map[string]any)
		require.True(t, ok)
		require.NotContains(t, storedTagItem, "variables")

		legacyGet := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + uid,
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, legacyGet.Response.StatusCode)
		require.NotNil(t, legacyGet.Result)
		require.Len(t, legacyGet.Result.Items, 3)
		require.Equal(t, map[string][]string{"host": {"a", "b"}, "cluster": {"c"}}, legacyGet.Result.Items[0].Variables)
		require.Equal(t, map[string][]string{"host": {"z"}}, legacyGet.Result.Items[1].Variables)
		require.Nil(t, legacyGet.Result.Items[2].Variables)

		legacyItems := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + uid + "/items",
		}, &[]playlist.PlaylistItemDTO{})
		require.Equal(t, 200, legacyItems.Response.StatusCode)
		require.NotNil(t, legacyItems.Result)
		require.Equal(t, legacyGet.Result.Items, *legacyItems.Result)

		// The update handler replaces the whole spec from the payload, so the edited payload
		// resends every item that should survive the update.
		updatedPayload := strings.Replace(legacyPayload, `"variables": { "host": ["z"] }`, `"variables": { "host": ["q"] }`, 1)
		require.NotEqual(t, legacyPayload, updatedPayload)
		dtoResponse := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodPut,
			Path:   "/api/playlists/" + uid,
			Body:   []byte(updatedPayload),
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, dtoResponse.Response.StatusCode)
		require.NotNil(t, dtoResponse.Result)
		require.Len(t, dtoResponse.Result.Items, 3)
		require.Equal(t, map[string][]string{"host": {"q"}}, dtoResponse.Result.Items[1].Variables)

		found, err = client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
		require.NoError(t, err)
		require.JSONEq(t,
			strings.Replace(expectedResult, `"host": ["z"]`, `"host": ["q"]`, 1),
			client.SanitizeJSON(found, "labels"))

		// spec.title and spec.interval are required here because the legacy DTO conversion
		// type-asserts both of them without a guard.
		k8sName := "playlist-with-variables"
		k8sCreated, err := client.Resource.Create(context.Background(),
			helper.LoadYAMLOrJSON(`{
				"apiVersion": "playlist.grafana.app/v1",
				"kind": "Playlist",
				"metadata": { "name": "`+k8sName+`" },
				"spec": {
				  "title": "Created from k8s with variables",
				  "interval": "5m",
				  "items": [
					{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["a", "b"] } },
					{ "type": "dashboard_by_tag", "value": "graph-ng" }
				  ]
				}
			  }`),
			metav1.CreateOptions{},
		)
		t.Cleanup(func() {
			_ = client.Resource.Delete(context.Background(), k8sName, metav1.DeleteOptions{})
		})
		require.NoError(t, err)
		require.Equal(t, k8sName, k8sCreated.GetName())

		legacyGet = apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + k8sName,
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, legacyGet.Response.StatusCode)
		require.NotNil(t, legacyGet.Result)
		require.Len(t, legacyGet.Result.Items, 2)
		require.Equal(t, map[string][]string{"host": {"a", "b"}}, legacyGet.Result.Items[0].Variables)
		require.Nil(t, legacyGet.Result.Items[1].Variables)

		// v0alpha1 shares the item definition with v1, so a read through the older version
		// must return the stored variables unchanged.
		clientV0alpha1 := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR: schema.GroupVersionResource{
				Group:    gvr.Group,
				Version:  "v0alpha1",
				Resource: gvr.Resource,
			},
		})
		foundV0alpha1, err := clientV0alpha1.Resource.Get(context.Background(), k8sName, metav1.GetOptions{})
		require.NoError(t, err)
		v0alpha1Items, _, err := unstructured.NestedSlice(foundV0alpha1.Object, "spec", "items")
		require.NoError(t, err)
		require.Len(t, v0alpha1Items, 2)
		require.Equal(t, map[string]any{
			"type":  "dashboard_by_uid",
			"value": "xCmMwXdVz",
			"variables": map[string]any{
				"host": []any{"a", "b"},
			},
		}, v0alpha1Items[0])
		v0alpha1TagItem, ok := v0alpha1Items[1].(map[string]any)
		require.True(t, ok)
		require.NotContains(t, v0alpha1TagItem, "variables")
	})

	// Every write path enforces the same two rules before anything is stored: the playlist
	// collection budget, and the contract that a variable holds one or more non-empty string
	// values. The legacy endpoints enforce it in front of the conversion, and both served
	// versions enforce it through the single shared admission validator. Each case compares the
	// size of the collection before and after the rejected write, so a rejection that still
	// persisted an object fails here, and every attempted creation registers its cleanup
	// immediately so the org-scoped List assertions in the sibling sub-tests stay valid.
	t.Run("Reject playlist item variables that break the contract", func(t *testing.T) {
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR:  gvr,
		})

		countPlaylists := func(t *testing.T) int {
			t.Helper()
			list, err := client.Resource.List(context.Background(), metav1.ListOptions{})
			require.NoError(t, err)
			return len(list.Items)
		}

		// One variable past the maximum, and one item past it: both are built here rather than
		// written out, and both are driven by the shared constants so the fixtures follow the
		// budget instead of restating it.
		overLimitVariables := &strings.Builder{}
		for i := range playlistapp.MaxItemVariables + 1 {
			if i > 0 {
				overLimitVariables.WriteString(",")
			}
			fmt.Fprintf(overLimitVariables, `"host-%d":["a"]`, i)
		}
		overLimitItems := &strings.Builder{}
		for i := range playlistapp.MaxPlaylistItems + 1 {
			if i > 0 {
				overLimitItems.WriteString(",")
			}
			fmt.Fprintf(overLimitItems, `{"type":"dashboard_by_uid","value":"uid-%d"}`, i)
		}

		legacyCases := []struct {
			name  string
			items string
		}{
			{
				name:  "a null value list",
				items: `[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":null}}]`,
			},
			{
				name:  "a null array element",
				items: `[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":[null]}}]`,
			},
			{
				name:  "more variables than the maximum",
				items: `[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{` + overLimitVariables.String() + `}}]`,
			},
			{
				name:  "more items than the maximum",
				items: `[` + overLimitItems.String() + `]`,
			},
			{
				// One item, one oversized value: the body is refused while it is being read,
				// before it is decoded into items at all, which is the only limit that bounds
				// a payload whose size is not in its element count.
				name:  "a body larger than the cap",
				items: `[{"type":"dashboard_by_uid","value":"` + strings.Repeat("v", 5<<20) + `"}]`,
			},
		}
		for _, tc := range legacyCases {
			t.Run("legacy POST with "+tc.name, func(t *testing.T) {
				before := countPlaylists(t)
				rejected := apis.DoRequest(helper, apis.RequestParams{
					User:   client.Args.User,
					Method: http.MethodPost,
					Path:   "/api/playlists",
					Body:   []byte(`{"name":"Over budget","interval":"20s","items":` + tc.items + `,"uid":""}`),
				}, &playlist.Playlist{})
				// The legacy handler answers a refused body with the same 400 it uses for a
				// malformed one; the field-level detail is logged rather than returned.
				require.Equal(t, http.StatusBadRequest, rejected.Response.StatusCode)
				require.Equal(t, before, countPlaylists(t),
					"a rejected legacy write must not create a playlist")
			})
		}

		resourceCases := []struct {
			name      string
			variables string
			// path is the field path the rejection must name, which is what proves the
			// playlist validator refused the write rather than something incidental.
			path string
		}{
			{
				name:      "a null value list",
				variables: `{"host":null}`,
				path:      "spec.items[0].variables[host]",
			},
			{
				name:      "a null array element",
				variables: `{"host":[null]}`,
				path:      "spec.items[0].variables[host][0]",
			},
			{
				name:      "more variables than the maximum",
				variables: `{` + overLimitVariables.String() + `}`,
				path:      "spec.items[0].variables",
			},
		}
		// Both versions are checked through the same cases: the two ManagedKinds entries share
		// one validator instance, and a version that stopped enforcing the contract would
		// otherwise be a way around it that only shows up in production.
		for _, version := range []string{"v1", "v0alpha1"} {
			versionClient := helper.GetResourceClient(apis.ResourceClientArgs{
				User: helper.Org1.Editor,
				GVR: schema.GroupVersionResource{
					Group:    gvr.Group,
					Version:  version,
					Resource: gvr.Resource,
				},
			})
			for i, tc := range resourceCases {
				t.Run(version+" create with "+tc.name, func(t *testing.T) {
					name := fmt.Sprintf("rejected-%s-%d", version, i)
					before := countPlaylists(t)
					created, err := versionClient.Resource.Create(context.Background(),
						helper.LoadYAMLOrJSON(`{
							"apiVersion": "playlist.grafana.app/`+version+`",
							"kind": "Playlist",
							"metadata": { "name": "`+name+`" },
							"spec": {
							  "title": "Over budget",
							  "interval": "5m",
							  "items": [
								{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": `+tc.variables+` }
							  ]
							}
						  }`),
						metav1.CreateOptions{},
					)
					// Registered immediately after the attempt, before the assertions below:
					// if admission ever stopped refusing this payload the object would exist,
					// and the fatal assertions that follow must not leave it behind.
					t.Cleanup(func() {
						err := client.Resource.Delete(context.Background(), name, metav1.DeleteOptions{})
						if err != nil && !apierrors.IsNotFound(err) {
							t.Errorf("failed to clean up playlist %s: %v", name, err)
						}
					})
					require.Error(t, err)
					require.Nil(t, created)
					require.Contains(t, err.Error(), tc.path)
					require.Equal(t, before, countPlaylists(t),
						"a rejected resource write must not create a playlist")

					_, err = client.Resource.Get(context.Background(), name, metav1.GetOptions{})
					require.True(t, apierrors.IsNotFound(err),
						"the rejected object must not exist, got %v", err)
				})
			}
		}

		t.Run("replace and patch of a stored playlist", func(t *testing.T) {
			name := "playlist-variables-contract"
			created, err := client.Resource.Create(context.Background(),
				helper.LoadYAMLOrJSON(`{
					"apiVersion": "playlist.grafana.app/v1",
					"kind": "Playlist",
					"metadata": { "name": "`+name+`" },
					"spec": {
					  "title": "Within budget",
					  "interval": "5m",
					  "items": [
						{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["a"] } }
					  ]
					}
				  }`),
				metav1.CreateOptions{},
			)
			t.Cleanup(func() {
				err := client.Resource.Delete(context.Background(), name, metav1.DeleteOptions{})
				if err != nil && !apierrors.IsNotFound(err) {
					t.Errorf("failed to clean up playlist %s: %v", name, err)
				}
			})
			require.NoError(t, err)
			require.Equal(t, name, created.GetName())

			// PUT :: the whole spec is replaced, with one variable set to null
			replaced := created.DeepCopy()
			require.NoError(t, unstructured.SetNestedSlice(replaced.Object, []any{
				map[string]any{
					"type":      "dashboard_by_uid",
					"value":     "xCmMwXdVz",
					"variables": map[string]any{"host": nil},
				},
			}, "spec", "items"))
			_, err = client.Resource.Update(context.Background(), replaced, metav1.UpdateOptions{})
			require.Error(t, err)
			require.Contains(t, err.Error(), "spec.items[0].variables[host]")

			// PATCH :: a JSON patch, not a merge patch. A JSON merge patch cannot express this
			// case at all: null means "remove this key" to the merge algorithm, and the nulls
			// inside a replacement value are pruned with it, so the same payload as a merge
			// patch produces an item with no variables and is legitimately accepted.
			_, err = client.Resource.Patch(context.Background(), name, types.JSONPatchType,
				[]byte(`[{"op":"replace","path":"/spec/items/0/variables/host","value":null}]`),
				metav1.PatchOptions{})
			require.Error(t, err)
			require.Contains(t, err.Error(), "spec.items[0].variables[host]")

			// PATCH :: the budget applies to a patched object as much as to a replaced one
			_, err = client.Resource.Patch(context.Background(), name, types.MergePatchType,
				[]byte(`{"spec":{"items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{`+
					overLimitVariables.String()+`}}]}}`),
				metav1.PatchOptions{})
			require.Error(t, err)
			require.Contains(t, err.Error(), "spec.items[0].variables")

			// Neither refused write changed what is stored
			found, err := client.Resource.Get(context.Background(), name, metav1.GetOptions{})
			require.NoError(t, err)
			items, _, err := unstructured.NestedSlice(found.Object, "spec", "items")
			require.NoError(t, err)
			require.Len(t, items, 1)
			storedItem, ok := items[0].(map[string]any)
			require.True(t, ok)
			require.Equal(t, map[string]any{"host": []any{"a"}}, storedItem["variables"])
		})
	})

	t.Run("Do CRUD via k8s (and check that legacy api still works)", func(t *testing.T) {
		t.Skip()
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR:  gvr,
		})

		first, err := client.Resource.Create(context.Background(),
			helper.LoadYAMLOrJSONFile("testdata/playlist-test-create.yaml"),
			metav1.CreateOptions{},
		)
		require.NoError(t, err)
		require.Equal(t, "test", first.GetName())
		uids := []string{first.GetName()} //nolint:prealloc

		for range 2 {
			out, err := client.Resource.Create(context.Background(),
				helper.LoadYAMLOrJSONFile("testdata/playlist-generate.yaml"),
				metav1.CreateOptions{},
			)
			require.NoError(t, err)
			uids = append(uids, out.GetName())
		}
		slices.Sort(uids)

		list, err := client.Resource.List(context.Background(), metav1.ListOptions{})
		require.NoError(t, err)
		require.Equal(t, uids, SortSlice(Map(list.Items, func(item unstructured.Unstructured) string {
			return item.GetName()
		})))

		searchResponse := apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists",
		}, &playlist.Playlists{})
		require.NotNil(t, searchResponse.Result)
		require.Equal(t, uids, SortSlice(Map(*searchResponse.Result, func(item *playlist.Playlist) string {
			return item.UID
		})))

		for _, uid := range uids {
			getFromBothAPIs(t, helper, client, uid, nil)
		}

		updated, err := client.Resource.Update(context.Background(),
			helper.LoadYAMLOrJSONFile("testdata/playlist-test-replace.yaml"),
			metav1.UpdateOptions{},
		)
		require.NoError(t, err)
		require.Equal(t, first.GetName(), updated.GetName())
		require.Equal(t, first.GetUID(), updated.GetUID())
		require.Less(t, first.GetResourceVersion(), updated.GetResourceVersion())
		out := getFromBothAPIs(t, helper, client, "test", &playlist.PlaylistDTO{
			Name:     "Test playlist (replaced from k8s; 22m; 1 items; PUT)",
			Interval: "22m",
		})
		require.Equal(t, updated.GetResourceVersion(), out.GetResourceVersion())

		updated, err = client.Resource.Apply(context.Background(), "test",
			helper.LoadYAMLOrJSONFile("testdata/playlist-test-apply.yaml"),
			metav1.ApplyOptions{
				Force:        true,
				FieldManager: "testing",
			},
		)
		require.NoError(t, err)
		require.Equal(t, first.GetName(), updated.GetName())
		require.Equal(t, first.GetUID(), updated.GetUID())
		require.Less(t, first.GetResourceVersion(), updated.GetResourceVersion())
		getFromBothAPIs(t, helper, client, "test", &playlist.PlaylistDTO{
			Name:     "Test playlist (apply from k8s; ??m; ?? items; PATCH)",
			Interval: "22m", // has not changed from previous update
		})

		for _, uid := range uids {
			err := client.Resource.Delete(context.Background(), uid, metav1.DeleteOptions{})
			require.NoError(t, err)

			err = client.Resource.Delete(context.Background(), uid, metav1.DeleteOptions{})
			statusError := helper.AsStatusError(err)
			require.Equal(t, metav1.StatusReasonNotFound, statusError.Status().Reason)

			_, err = client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
			statusError = helper.AsStatusError(err)
			require.Equal(t, metav1.StatusReasonNotFound, statusError.Status().Reason)
		}

		list, err = client.Resource.List(context.Background(), metav1.ListOptions{})
		require.NoError(t, err)
		require.Empty(t, list.Items)
	})

	return helper
}

func Map[A any, B any](input []A, m func(A) B) []B {
	output := make([]B, len(input))
	for i, element := range input {
		output[i] = m(element)
	}
	return output
}

func SortSlice[A cmp.Ordered](input []A) []A {
	slices.Sort(input)
	return input
}

func getFromBothAPIs(t *testing.T,
	helper *apis.K8sTestHelper,
	client *apis.K8sResourceClient,
	uid string,
	expect *playlist.PlaylistDTO,
) *unstructured.Unstructured {
	t.Helper()

	found, err := client.Resource.Get(context.Background(), uid, metav1.GetOptions{})
	require.NoError(t, err)
	require.Equal(t, uid, found.GetName())

	dto := apis.DoRequest(helper, apis.RequestParams{
		User:   client.Args.User,
		Method: http.MethodGet,
		Path:   "/api/playlists/" + uid,
	}, &playlist.PlaylistDTO{}).Result
	require.NotNil(t, dto)
	require.Equal(t, uid, dto.Uid)

	spec, ok := found.Object["spec"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, dto.Uid, found.GetName())
	require.Equal(t, dto.Name, spec["title"])
	require.Equal(t, dto.Interval, spec["interval"])

	a, errA := json.Marshal(spec["items"])
	b, errB := json.Marshal(dto.Items)
	require.NoError(t, errA)
	require.NoError(t, errB)
	require.JSONEq(t, string(a), string(b))

	if expect != nil {
		if expect.Name != "" {
			require.Equal(t, expect.Name, dto.Name)
			require.Equal(t, expect.Name, spec["title"])
		}
		if expect.Interval != "" {
			require.Equal(t, expect.Interval, dto.Interval)
			require.Equal(t, expect.Interval, spec["interval"])
		}
		if expect.Uid != "" {
			require.Equal(t, expect.Uid, dto.Uid)
			require.Equal(t, expect.Uid, found.GetName())
		}
	}
	return found
}

// TestIntegrationPlaylistAnonymousOrgIsolation pins the organization boundary for the
// configured anonymous identity on both served versions of the resource API.
//
// The configuration under test is the one that makes the read path reachable: anonymous
// access is enabled and bound to a single organization, and playlistsRBAC is left at its
// default of off, so the playlist authorizer expresses no opinion for a Viewer and the org
// role authorizer grants the read verbs. In that state the namespace named in the request
// URL must not move the anonymous identity into another organization, because a playlist
// spec — including the per-item template variable values — is organization-scoped data.
func TestIntegrationPlaylistAnonymousOrgIsolation(t *testing.T) {
	testutil.SkipIntegrationTestInShortMode(t)

	helper := apis.NewK8sTestHelper(t, testinfra.GrafanaOpts{
		AppModeProduction: true,           // do not start extra port 6443
		AnonymousUserRole: org.RoleViewer, // anonymous lands in org 1, the harness anonymous org
		// [auth.anonymous] enabled = true is the harness default and is what this test needs,
		// so DisableAnonymous stays false. playlistsRBAC is deliberately not enabled.
	})

	anonNamespace := apis.DefaultNamespace
	otherNamespace := helper.Namespacer(helper.OrgB.Admin.Identity.GetOrgID())
	require.NotEqual(t, anonNamespace, otherNamespace, "the two organizations must have distinct namespaces")

	// The asset that must stay invisible: a playlist owned by the other organization whose
	// title and variable value are distinctive enough to be searched for in any response body.
	const (
		otherOrgTitle         = "Other org playlist"
		otherOrgVariableValue = "anon-isolation-secret-host"
	)
	otherOrgClient := helper.GetResourceClient(apis.ResourceClientArgs{
		User: helper.OrgB.Admin,
		GVR:  gvr,
	})
	otherOrgPlaylist, err := otherOrgClient.Resource.Create(context.Background(),
		helper.LoadYAMLOrJSON(fmt.Sprintf(`{
			"apiVersion": "playlist.grafana.app/v1",
			"kind": "Playlist",
			"metadata": { "generateName": "x" },
			"spec": {
				"title": %q,
				"interval": "5m",
				"items": [
					{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": [%q] } }
				]
			}
		}`, otherOrgTitle, otherOrgVariableValue)),
		metav1.CreateOptions{},
	)
	require.NoError(t, err)
	require.NotEmpty(t, otherOrgPlaylist.GetName())
	t.Cleanup(func() {
		err := otherOrgClient.Resource.Delete(context.Background(), otherOrgPlaylist.GetName(), metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			t.Errorf("failed to clean up playlist %s: %v", otherOrgPlaylist.GetName(), err)
		}
	})

	// A playlist in the anonymous identity's own organization: scoping anonymous access must
	// not remove it, so this object has to stay readable without credentials.
	anonOrgClient := helper.GetResourceClient(apis.ResourceClientArgs{
		User: helper.Org1.Admin,
		GVR:  gvr,
	})
	anonOrgPlaylist, err := anonOrgClient.Resource.Create(context.Background(),
		helper.LoadYAMLOrJSON(`{
			"apiVersion": "playlist.grafana.app/v1",
			"kind": "Playlist",
			"metadata": { "generateName": "x" },
			"spec": {
				"title": "Anonymous org playlist",
				"interval": "5m",
				"items": [
					{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["own-org-host"] } }
				]
			}
		}`),
		metav1.CreateOptions{},
	)
	require.NoError(t, err)
	require.NotEmpty(t, anonOrgPlaylist.GetName())
	t.Cleanup(func() {
		err := anonOrgClient.Resource.Delete(context.Background(), anonOrgPlaylist.GetName(), metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			t.Errorf("failed to clean up playlist %s: %v", anonOrgPlaylist.GetName(), err)
		}
	})

	for _, version := range []string{"v1", "v0alpha1"} {
		t.Run(version, func(t *testing.T) {
			collection := fmt.Sprintf("/apis/%s/%s/namespaces/%s/playlists", gvr.Group, version, otherNamespace)
			name := otherOrgPlaylist.GetName()

			// Every read shape the resource API serves for another organization's namespace.
			// The watch bounds itself with timeoutSeconds so an allowed watch answers instead
			// of streaming until the client times out.
			for _, tc := range []struct {
				verb string
				path string
				// nameInPath marks the requests that address the object by name. Their denial
				// is reported through the standard Kubernetes Forbidden message, which echoes
				// the name the caller itself put in the URL, so that name is not evidence of
				// disclosure and only the stored spec is asserted against.
				nameInPath bool
			}{
				{verb: "list", path: collection},
				{verb: "watch", path: collection + "?watch=true&timeoutSeconds=1"},
				{verb: "get", path: collection + "/" + name, nameInPath: true},
				{verb: "get status", path: collection + "/" + name + "/status", nameInPath: true},
			} {
				t.Run(tc.verb, func(t *testing.T) {
					// No User: the request carries no credentials, so it is served as the
					// configured anonymous identity.
					rsp := apis.DoRequest(helper, apis.RequestParams{
						Method: http.MethodGet,
						Path:   tc.path,
					}, &apis.AnyResourceList{})

					require.Equal(t, http.StatusForbidden, rsp.Response.StatusCode, string(rsp.Body))
					require.NotNil(t, rsp.Status, string(rsp.Body))
					require.Equal(t, metav1.StatusReasonForbidden, rsp.Status.Reason)
					// DoRequest clears Result when the body is a Status, so a nil Result is
					// how "the response carried no objects at all" reads here.
					require.Nil(t, rsp.Result, "a denied read must carry no objects")
					require.NotContains(t, string(rsp.Body), otherOrgVariableValue,
						"another organization's variable values must never reach an anonymous reader")
					require.NotContains(t, string(rsp.Body), otherOrgTitle,
						"another organization's playlist titles must never reach an anonymous reader")
					if !tc.nameInPath {
						require.NotContains(t, string(rsp.Body), name,
							"another organization's playlist names must never reach an anonymous reader")
					}
				})
			}

			t.Run("reads its own organization", func(t *testing.T) {
				rsp := apis.DoRequest(helper, apis.RequestParams{
					Method: http.MethodGet,
					Path:   fmt.Sprintf("/apis/%s/%s/namespaces/%s/playlists", gvr.Group, version, anonNamespace),
				}, &apis.AnyResourceList{})

				require.Equal(t, http.StatusOK, rsp.Response.StatusCode, string(rsp.Body))
				require.Nil(t, rsp.Status)
				require.NotNil(t, rsp.Result)
				require.Contains(t, string(rsp.Body), anonOrgPlaylist.GetName(),
					"the anonymous identity must still read the organization it is configured for")
				require.NotContains(t, string(rsp.Body), otherOrgVariableValue)
			})
		})
	}
}
