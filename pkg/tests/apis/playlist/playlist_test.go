package playlist

import (
	"cmp"
	"context"
	"encoding/json"
	stderrors "errors"
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

		// The write direction of the shared item definition. The read above only proves that
		// v0alpha1 can render what v1 stored; a client that never moved off v0alpha1 also
		// writes through it, so the variables it sends must reach storage and be readable
		// through v1 and through the legacy API unchanged.
		v0alpha1Name := "playlist-written-through-v0alpha1"
		v0alpha1Created, err := clientV0alpha1.Resource.Create(context.Background(),
			helper.LoadYAMLOrJSON(`{
				"apiVersion": "playlist.grafana.app/v0alpha1",
				"kind": "Playlist",
				"metadata": { "name": "`+v0alpha1Name+`" },
				"spec": {
				  "title": "Created from k8s v0alpha1 with variables",
				  "interval": "7m",
				  "items": [
					{ "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["h1", "h2"], "cluster": ["c1"] } },
					{ "type": "dashboard_by_tag", "value": "graph-ng" }
				  ]
				}
			  }`),
			metav1.CreateOptions{},
		)
		t.Cleanup(func() {
			_ = client.Resource.Delete(context.Background(), v0alpha1Name, metav1.DeleteOptions{})
		})
		require.NoError(t, err)
		require.Equal(t, v0alpha1Name, v0alpha1Created.GetName())

		expectedWrittenItem := map[string]any{
			"type":  "dashboard_by_uid",
			"value": "xCmMwXdVz",
			"variables": map[string]any{
				"host":    []any{"h1", "h2"},
				"cluster": []any{"c1"},
			},
		}

		createdItems, _, err := unstructured.NestedSlice(v0alpha1Created.Object, "spec", "items")
		require.NoError(t, err)
		require.Len(t, createdItems, 2)
		require.Equal(t, expectedWrittenItem, createdItems[0])

		foundV1, err := client.Resource.Get(context.Background(), v0alpha1Name, metav1.GetOptions{})
		require.NoError(t, err)
		v1Items, _, err := unstructured.NestedSlice(foundV1.Object, "spec", "items")
		require.NoError(t, err)
		require.Len(t, v1Items, 2)
		require.Equal(t, expectedWrittenItem, v1Items[0])
		v1TagItem, ok := v1Items[1].(map[string]any)
		require.True(t, ok)
		require.NotContains(t, v1TagItem, "variables")

		legacyGet = apis.DoRequest(helper, apis.RequestParams{
			User:   client.Args.User,
			Method: http.MethodGet,
			Path:   "/api/playlists/" + v0alpha1Name,
		}, &playlist.PlaylistDTO{})
		require.Equal(t, 200, legacyGet.Response.StatusCode)
		require.NotNil(t, legacyGet.Result)
		require.Len(t, legacyGet.Result.Items, 2)
		require.Equal(t, map[string][]string{"host": {"h1", "h2"}, "cluster": {"c1"}}, legacyGet.Result.Items[0].Variables)
		require.Nil(t, legacyGet.Result.Items[1].Variables)
	})

	t.Run("Refuse playlist item variables that break the published maxima", func(t *testing.T) {
		// The maxima are enforced by admission (apps/playlist/pkg/app/app.go), which the
		// aggregated apiserver consults for every write path, so this sub-test is what proves a
		// refusal reaches the client as 422 Invalid with a usable field path rather than as a
		// 403 with the causes flattened away -- and that the legacy endpoints, which proxy
		// through the same chain, refuse the same payloads.
		client := helper.GetResourceClient(apis.ResourceClientArgs{
			User: helper.Org1.Editor,
			GVR:  gvr,
		})

		payload := func(t *testing.T, name string, variables map[string][]string) *unstructured.Unstructured {
			t.Helper()
			encoded, err := json.Marshal(variables)
			require.NoError(t, err)
			return helper.LoadYAMLOrJSON(fmt.Sprintf(`{
				"apiVersion": "playlist.grafana.app/v1",
				"kind": "Playlist",
				"metadata": { "name": %q },
				"spec": {
				  "title": "Variable maxima",
				  "interval": "5m",
				  "items": [ { "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": %s } ]
				}
			  }`, name, encoded))
		}

		causeFields := func(t *testing.T, err error) []string {
			t.Helper()
			var statusErr *apierrors.StatusError
			require.True(t, stderrors.As(err, &statusErr), "expected a status error, got %T: %v", err, err)
			require.Equal(t, int32(http.StatusUnprocessableEntity), statusErr.ErrStatus.Code)
			require.NotNil(t, statusErr.ErrStatus.Details)
			fields := make([]string, 0, len(statusErr.ErrStatus.Details.Causes))
			for _, cause := range statusErr.ErrStatus.Details.Causes {
				fields = append(fields, cause.Field)
			}
			return fields
		}

		manyVariables := func(count int) map[string][]string {
			variables := make(map[string][]string, count)
			for i := range count {
				variables[fmt.Sprintf("host%03d", i)] = []string{"a"}
			}
			return variables
		}
		manyValues := func(count int) []string {
			values := make([]string, 0, count)
			for i := range count {
				values = append(values, fmt.Sprintf("host%03d", i))
			}
			return values
		}

		// The maxima published in the item schema. Written out rather than imported so the
		// numbers a client reads in the OpenAPI document are the numbers asserted here.
		const (
			maxVariables = 32
			maxValues    = 64
			maxNameLen   = 128
			maxValueLen  = 1024
		)

		for _, tc := range []struct {
			name       string
			variables  map[string][]string
			wantFields []string
		}{
			{
				name:       "a 2 MB value",
				variables:  map[string][]string{"host": {strings.Repeat("X", 2*1000*1000)}},
				wantFields: []string{"spec.items[0].variables[host][0]"},
			},
			{
				name:       "one variable past the item maximum",
				variables:  manyVariables(maxVariables + 1),
				wantFields: []string{"spec.items[0].variables"},
			},
			{
				name:       "5000 variables",
				variables:  manyVariables(5000),
				wantFields: []string{"spec.items[0].variables"},
			},
			{
				name:       "one value past the per-variable maximum",
				variables:  map[string][]string{"host": manyValues(maxValues + 1)},
				wantFields: []string{"spec.items[0].variables[host]"},
			},
			{
				name:       "a name one code point too long",
				variables:  map[string][]string{strings.Repeat("n", maxNameLen+1): {"a"}},
				wantFields: []string{"spec.items[0].variables[" + strings.Repeat("n", maxNameLen) + "...]"},
			},
			{
				name:       "a value one code point too long",
				variables:  map[string][]string{"host": {strings.Repeat("v", maxValueLen+1)}},
				wantFields: []string{"spec.items[0].variables[host][0]"},
			},
			{
				// U+200B passes Go's whitespace trimming, so before the shared rule it was
				// stored and then played as an invisible `var-%E2%80%8B` parameter.
				name:       "a zero width space name",
				variables:  map[string][]string{"\u200b": {"a"}},
				wantFields: []string{"spec.items[0].variables[\u200b]"},
			},
			{
				// U+FEFF was stored by the API and skipped by playback: the two layers
				// disagreed about whether the variable existed.
				name:       "a byte order mark name",
				variables:  map[string][]string{"\ufeff": {"a"}},
				wantFields: []string{"spec.items[0].variables[\ufeff]"},
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				name := "playlist-refused-" + strings.ReplaceAll(tc.name, " ", "-")
				_, err := client.Resource.Create(context.Background(), payload(t, name, tc.variables), metav1.CreateOptions{})
				require.Error(t, err)
				require.True(t, apierrors.IsInvalid(err), "expected Invalid, got %v", err)
				require.Equal(t, tc.wantFields, causeFields(t, err))

				// Nothing was persisted, so the refusal is a refusal and not a warning.
				_, err = client.Resource.Get(context.Background(), name, metav1.GetOptions{})
				require.True(t, apierrors.IsNotFound(err), "expected the object to be absent, got %v", err)
			})
		}

		t.Run("a payload at every maximum is accepted", func(t *testing.T) {
			// The maxima are the editor's own, so a map the editor commits has to be stored:
			// the widest map, the longest value list, the longest name and the longest value.
			atLimit := manyVariables(maxVariables - 3)
			atLimit["values-at-maximum"] = manyValues(maxValues)
			atLimit[strings.Repeat("n", maxNameLen)] = []string{"a"}
			atLimit["value-at-maximum"] = []string{strings.Repeat("v", maxValueLen)}
			require.Len(t, atLimit, maxVariables)

			const name = "playlist-at-variable-maxima"
			created, err := client.Resource.Create(context.Background(), payload(t, name, atLimit), metav1.CreateOptions{})
			t.Cleanup(func() {
				_ = client.Resource.Delete(context.Background(), name, metav1.DeleteOptions{})
			})
			require.NoError(t, err)
			require.Equal(t, name, created.GetName())

			legacyGet := apis.DoRequest(helper, apis.RequestParams{
				User:   client.Args.User,
				Method: http.MethodGet,
				Path:   "/api/playlists/" + name,
			}, &playlist.PlaylistDTO{})
			require.Equal(t, 200, legacyGet.Response.StatusCode)
			require.NotNil(t, legacyGet.Result)
			require.Len(t, legacyGet.Result.Items, 1)
			require.Equal(t, atLimit, legacyGet.Result.Items[0].Variables)
		})

		t.Run("the deprecated legacy endpoints refuse the same payload", func(t *testing.T) {
			// /api/playlists proxies to the same apiserver, and pkg/api/playlist.go writes the
			// status code it gets back, so the 422 has to survive the legacy envelope too.
			oversized := `{ "host": ["` + strings.Repeat("X", 2*1000*1000) + `"] }`
			legacyCreate := apis.DoRequest(helper, apis.RequestParams{
				User:   client.Args.User,
				Method: http.MethodPost,
				Path:   "/api/playlists",
				Body: []byte(`{
					"name": "Legacy oversized",
					"interval": "5m",
					"items": [ { "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": ` + oversized + ` } ],
					"uid": ""
				  }`),
			}, &playlist.Playlist{})
			require.Equal(t, http.StatusUnprocessableEntity, legacyCreate.Response.StatusCode)

			// The update path is admitted separately from the create path, so it is checked
			// separately: a playlist that is legal today must not become oversized by a PUT.
			legacyValid := apis.DoRequest(helper, apis.RequestParams{
				User:   client.Args.User,
				Method: http.MethodPost,
				Path:   "/api/playlists",
				Body: []byte(`{
					"name": "Legacy bounded",
					"interval": "5m",
					"items": [ { "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["a"] } } ],
					"uid": ""
				  }`),
			}, &playlist.Playlist{})
			t.Cleanup(func() {
				if legacyValid.Result == nil || legacyValid.Result.UID == "" {
					return
				}
				err := client.Resource.Delete(context.Background(), legacyValid.Result.UID, metav1.DeleteOptions{})
				if err != nil && !apierrors.IsNotFound(err) {
					t.Errorf("failed to clean up playlist %s: %v", legacyValid.Result.UID, err)
				}
			})
			require.Equal(t, 200, legacyValid.Response.StatusCode)
			require.NotNil(t, legacyValid.Result)
			uid := legacyValid.Result.UID
			require.NotEmpty(t, uid)

			legacyUpdate := apis.DoRequest(helper, apis.RequestParams{
				User:   client.Args.User,
				Method: http.MethodPut,
				Path:   "/api/playlists/" + uid,
				Body: []byte(`{
					"name": "Legacy bounded",
					"interval": "5m",
					"items": [ { "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": ` + oversized + ` } ],
					"uid": "` + uid + `"
				  }`),
			}, &playlist.PlaylistDTO{})
			require.Equal(t, http.StatusUnprocessableEntity, legacyUpdate.Response.StatusCode)

			// The stored object still holds what the accepted write put there.
			stored := apis.DoRequest(helper, apis.RequestParams{
				User:   client.Args.User,
				Method: http.MethodGet,
				Path:   "/api/playlists/" + uid,
			}, &playlist.PlaylistDTO{})
			require.Equal(t, 200, stored.Response.StatusCode)
			require.NotNil(t, stored.Result)
			require.Len(t, stored.Result.Items, 1)
			require.Equal(t, map[string][]string{"host": {"a"}}, stored.Result.Items[0].Variables)
		})

		t.Run("v0alpha1 refuses the same payload", func(t *testing.T) {
			// Both served versions share the item definition, so both are admitted by the same
			// rules; a client that never moved off v0alpha1 cannot use it to bypass them.
			clientV0alpha1 := helper.GetResourceClient(apis.ResourceClientArgs{
				User: helper.Org1.Editor,
				GVR: schema.GroupVersionResource{
					Group:    gvr.Group,
					Version:  "v0alpha1",
					Resource: gvr.Resource,
				},
			})
			_, err := clientV0alpha1.Resource.Create(context.Background(),
				helper.LoadYAMLOrJSON(`{
					"apiVersion": "playlist.grafana.app/v0alpha1",
					"kind": "Playlist",
					"metadata": { "name": "playlist-v0alpha1-refused" },
					"spec": {
					  "title": "Variable maxima",
					  "interval": "5m",
					  "items": [ { "type": "dashboard_by_uid", "value": "xCmMwXdVz", "variables": { "host": ["`+strings.Repeat("X", 2*1000*1000)+`"] } } ]
					}
				  }`),
				metav1.CreateOptions{},
			)
			require.Error(t, err)
			require.True(t, apierrors.IsInvalid(err), "expected Invalid, got %v", err)
			require.Equal(t, []string{"spec.items[0].variables[host][0]"}, causeFields(t, err))
		})
	})

	t.Run("Do CRUD via k8s (and check that legacy api still works)", func(t *testing.T) {
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

		// Unified storage enforces optimistic concurrency, so a replacement must state the
		// version of the object it replaces. A file fixture cannot carry a server-generated
		// version, and the resource client sends the object as given, so the version of the
		// object created above is stamped onto it here -- the same read-then-stamp the legacy
		// PUT handler performs before it calls update. Reusing that version also keeps the
		// resource-version assertions below meaningful: the update only succeeds while
		// nothing else has touched the object since it was created.
		replacement := helper.LoadYAMLOrJSONFile("testdata/playlist-test-replace.yaml")
		replacement.SetResourceVersion(first.GetResourceVersion())
		updated, err := client.Resource.Update(context.Background(),
			replacement,
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
