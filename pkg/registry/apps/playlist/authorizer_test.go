package playlist

import (
	"context"
	"strings"
	"testing"

	claims "github.com/grafana/authlib/types"
	"github.com/open-feature/go-sdk/openfeature"
	"github.com/open-feature/go-sdk/openfeature/memprovider"
	oftesting "github.com/open-feature/go-sdk/openfeature/testing"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apiserver/pkg/authorization/authorizer"

	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/accesscontrol"
	grafanaauthorizer "github.com/grafana/grafana/pkg/services/apiserver/auth/authorizer"
	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/setting"
)

var provider = oftesting.NewTestProvider()

func TestMain(m *testing.M) {
	if err := openfeature.SetProviderAndWait(provider); err != nil {
		panic(err)
	}
	m.Run()
}

// mockAttributes implements authorizer.Attributes for testing
type mockAttributes struct {
	authorizer.Attributes
	isResourceRequest bool
	verb              string
}

func (m *mockAttributes) IsResourceRequest() bool { return m.isResourceRequest }
func (m *mockAttributes) GetVerb() string         { return m.verb }

func installerWithToggle(t *testing.T, on bool, ac accesscontrol.AccessControl) *AppInstaller {
	provider.UsingFlags(t, map[string]memprovider.InMemoryFlag{
		featuremgmt.FlagPlaylistsRBAC: setting.NewInMemoryFlag(featuremgmt.FlagPlaylistsRBAC, on),
	})
	return &AppInstaller{
		accessControl: ac,
		logger:        log.NewNopLogger(),
	}
}

// mockAccessControl implements accesscontrol.AccessControl for testing
type mockAccessControl struct {
	accesscontrol.AccessControl
	evaluateFunc func(ctx context.Context, user identity.Requester, evaluator accesscontrol.Evaluator) (bool, error)
}

func (m *mockAccessControl) Evaluate(ctx context.Context, user identity.Requester, evaluator accesscontrol.Evaluator) (bool, error) {
	if m.evaluateFunc != nil {
		return m.evaluateFunc(ctx, user, evaluator)
	}
	return false, nil
}

func (m *mockAccessControl) RegisterScopeAttributeResolver(prefix string, resolver accesscontrol.ScopeAttributeResolver) {
}

func (m *mockAccessControl) WithoutResolvers() accesscontrol.AccessControl {
	return m
}

func (m *mockAccessControl) InvalidateResolverCache(orgID int64, scope string) {}

func TestGetAuthorizer(t *testing.T) {
	tests := []struct {
		name             string
		verb             string
		isResourceReq    bool
		hasPermission    bool
		withoutUser      bool
		expectedDecision authorizer.Decision
		expectedAction   string
		expectedReason   string
	}{
		// Read verbs → playlists:read
		{
			name:             "get with read permission allows",
			verb:             "get",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsRead,
		},
		{
			name:             "get without read permission denies",
			verb:             "get",
			isResourceReq:    true,
			hasPermission:    false,
			expectedDecision: authorizer.DecisionDeny,
			expectedAction:   ActionPlaylistsRead,
			expectedReason:   "insufficient permissions",
		},
		{
			name:             "list with read permission allows",
			verb:             "list",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsRead,
		},
		{
			name:             "watch with read permission allows",
			verb:             "watch",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsRead,
		},
		// Write verbs → playlists:write
		{
			name:             "create with write permission allows",
			verb:             "create",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsWrite,
		},
		{
			name:             "create without write permission denies",
			verb:             "create",
			isResourceReq:    true,
			hasPermission:    false,
			expectedDecision: authorizer.DecisionDeny,
			expectedAction:   ActionPlaylistsWrite,
			expectedReason:   "insufficient permissions",
		},
		{
			name:             "update with write permission allows",
			verb:             "update",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsWrite,
		},
		{
			name:             "patch with write permission allows",
			verb:             "patch",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsWrite,
		},
		{
			name:             "delete with write permission allows",
			verb:             "delete",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsWrite,
		},
		{
			name:             "delete without write permission denies",
			verb:             "delete",
			isResourceReq:    true,
			hasPermission:    false,
			expectedDecision: authorizer.DecisionDeny,
			expectedAction:   ActionPlaylistsWrite,
			expectedReason:   "insufficient permissions",
		},
		{
			name:             "deletecollection with write permission allows",
			verb:             "deletecollection",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionAllow,
			expectedAction:   ActionPlaylistsWrite,
		},
		// Edge cases
		{
			name:             "non-resource request returns no opinion",
			verb:             "get",
			isResourceReq:    false,
			expectedDecision: authorizer.DecisionNoOpinion,
		},
		{
			name:             "unsupported verb denies",
			verb:             "unsupported",
			isResourceReq:    true,
			hasPermission:    true,
			expectedDecision: authorizer.DecisionDeny,
			expectedReason:   "unsupported verb: unsupported",
		},
		{
			name:             "missing user denies",
			verb:             "get",
			isResourceReq:    true,
			withoutUser:      true,
			expectedDecision: authorizer.DecisionDeny,
			expectedReason:   "valid user is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var evaluatedAction string
			mockAC := &mockAccessControl{
				evaluateFunc: func(ctx context.Context, user identity.Requester, evaluator accesscontrol.Evaluator) (bool, error) {
					evalStr := evaluator.String()
					if strings.Contains(evalStr, ActionPlaylistsRead) {
						evaluatedAction = ActionPlaylistsRead
					} else if strings.Contains(evalStr, ActionPlaylistsWrite) {
						evaluatedAction = ActionPlaylistsWrite
					}
					return tt.hasPermission, nil
				},
			}

			installer := installerWithToggle(t, true, mockAC)

			attrs := &mockAttributes{
				isResourceRequest: tt.isResourceReq,
				verb:              tt.verb,
			}

			ctx := context.Background()
			if !tt.withoutUser {
				ctx = identity.WithRequester(ctx, &identity.StaticRequester{
					OrgID:   1,
					UserID:  1,
					OrgRole: identity.RoleViewer,
				})
			}

			auth := installer.GetAuthorizer()
			decision, reason, err := auth.Authorize(ctx, attrs)

			if tt.withoutUser && tt.isResourceReq {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}

			assert.Equal(t, tt.expectedDecision, decision)
			if tt.expectedReason != "" {
				assert.Contains(t, reason, tt.expectedReason)
			}
			if tt.isResourceReq && !tt.withoutUser && tt.expectedAction != "" && tt.verb != "unsupported" {
				assert.Equal(t, tt.expectedAction, evaluatedAction)
			}
		})
	}
}

func TestGetAuthorizerToggleOff(t *testing.T) {
	mockAC := &mockAccessControl{}

	noneCtx := identity.WithRequester(context.Background(), &identity.StaticRequester{
		OrgID:   1,
		UserID:  1,
		OrgRole: identity.RoleNone,
	})
	viewerCtx := identity.WithRequester(context.Background(), &identity.StaticRequester{
		OrgID:   1,
		UserID:  2,
		OrgRole: identity.RoleViewer,
	})

	t.Run("non-resource request defers regardless of role", func(t *testing.T) {
		auth := installerWithToggle(t, false, mockAC).GetAuthorizer()
		attrs := &mockAttributes{isResourceRequest: false, verb: "get"}
		decision, _, err := auth.Authorize(noneCtx, attrs)
		require.NoError(t, err)
		assert.Equal(t, authorizer.DecisionNoOpinion, decision)
	})

	t.Run("None role with read verb allows (hotfix)", func(t *testing.T) {
		auth := installerWithToggle(t, false, mockAC).GetAuthorizer()
		for _, verb := range []string{"get", "list", "watch"} {
			attrs := &mockAttributes{isResourceRequest: true, verb: verb}
			decision, _, err := auth.Authorize(noneCtx, attrs)
			require.NoError(t, err)
			assert.Equal(t, authorizer.DecisionAllow, decision, "verb: %s", verb)
		}
	})

	t.Run("None role with write verb defers to roleAuthorizer", func(t *testing.T) {
		auth := installerWithToggle(t, false, mockAC).GetAuthorizer()
		for _, verb := range []string{"create", "update", "delete"} {
			attrs := &mockAttributes{isResourceRequest: true, verb: verb}
			decision, _, err := auth.Authorize(noneCtx, attrs)
			require.NoError(t, err)
			assert.Equal(t, authorizer.DecisionNoOpinion, decision, "verb: %s", verb)
		}
	})

	t.Run("non-None role defers to roleAuthorizer", func(t *testing.T) {
		auth := installerWithToggle(t, false, mockAC).GetAuthorizer()
		for _, verb := range []string{"get", "list", "create"} {
			attrs := &mockAttributes{isResourceRequest: true, verb: verb}
			decision, _, err := auth.Authorize(viewerCtx, attrs)
			require.NoError(t, err)
			assert.Equal(t, authorizer.DecisionNoOpinion, decision, "verb: %s", verb)
		}
	})
}

// playlistAttributes builds the request attributes the apiserver derives from a playlist
// resource URL, for the given served version and namespace.
func playlistAttributes(requester identity.Requester, version, namespace, verb, name, subresource string) authorizer.AttributesRecord {
	return authorizer.AttributesRecord{
		User:            requester,
		Verb:            verb,
		APIGroup:        "playlist.grafana.app",
		APIVersion:      version,
		Resource:        "playlists",
		Subresource:     subresource,
		Namespace:       namespace,
		Name:            name,
		ResourceRequest: true,
	}
}

// TestAuthorizationChainOrgIsolation exercises the playlist authorizer inside the
// authorization chain the apiserver actually builds, instead of on its own. That chain is
// where the organization boundary is drawn: the namespace authorizer runs before the
// per-API authorizer, so a request for another organization's namespace has to be denied
// before any playlist permission is evaluated, whatever the playlist authorizer or the org
// role authorizer would say about the verb. Both served versions register the same
// authorizer, so both are checked.
//
// The identity under test is the one the anonymous auth client builds: bound to the
// organization configured for anonymous access, carrying that organization's namespace and
// the configured role. It must read its own organization and nothing else.
func TestAuthorizationChainOrgIsolation(t *testing.T) {
	const (
		ownNamespace     = "default" // the organization anonymous access is configured for (org 1)
		foreignNamespace = "org-2"   // another tenant's namespace, taken from the request URL
		playlistName     = "aaa"
	)
	servedVersions := []string{"v1", "v0alpha1"}

	anonymous := &identity.StaticRequester{
		Type:      claims.TypeAnonymous,
		OrgID:     1,
		Namespace: ownNamespace,
		OrgRole:   identity.RoleViewer,
	}
	// Same identity with the None role: while playlistsRBAC is off the playlist authorizer
	// answers Allow for reads instead of deferring, which is the strongest grant the chain
	// can produce for playlists and so the sharpest test of the organization boundary.
	anonymousNone := &identity.StaticRequester{
		Type:      claims.TypeAnonymous,
		OrgID:     1,
		Namespace: ownNamespace,
		OrgRole:   identity.RoleNone,
	}
	grafanaAdmin := &identity.StaticRequester{
		Type:           claims.TypeUser,
		UserID:         1,
		OrgID:          1,
		Namespace:      ownNamespace,
		OrgRole:        identity.RoleAdmin,
		IsGrafanaAdmin: true,
	}

	// newChain mirrors how the apiserver assembles authorization: the built-in chain, with
	// this installer's authorizer registered for every version it serves. hasPermission is
	// what the access control service would answer once playlistsRBAC is on.
	newChain := func(t *testing.T, rbac bool, hasPermission bool) *grafanaauthorizer.GrafanaAuthorizer {
		installer := installerWithToggle(t, rbac, &mockAccessControl{
			evaluateFunc: func(context.Context, identity.Requester, accesscontrol.Evaluator) (bool, error) {
				return hasPermission, nil
			},
		})
		chain := grafanaauthorizer.NewGrafanaBuiltInSTAuthorizer()
		for _, version := range servedVersions {
			chain.Register(schema.GroupVersion{Group: "playlist.grafana.app", Version: version}, installer.GetAuthorizer())
		}
		return chain
	}

	// Every read shape the resource API serves, including the status subresource.
	reads := []struct {
		verb        string
		name        string
		subresource string
	}{
		{verb: "list"},
		{verb: "watch"},
		{verb: "get", name: playlistName},
		{verb: "get", name: playlistName, subresource: "status"},
	}

	for _, version := range servedVersions {
		t.Run(version, func(t *testing.T) {
			ctx := identity.WithRequester(context.Background(), anonymous)

			t.Run("another organization's namespace is denied", func(t *testing.T) {
				// playlistsRBAC off is the default, and the configuration in which the playlist
				// authorizer expresses no opinion for a Viewer and the org role authorizer
				// allows the read verbs.
				chain := newChain(t, false, false)
				for _, read := range reads {
					decision, reason, err := chain.Authorize(ctx,
						playlistAttributes(anonymous, version, foreignNamespace, read.verb, read.name, read.subresource))
					require.NoError(t, err)
					assert.Equal(t, authorizer.DecisionDeny, decision, "verb: %s%s", read.verb, read.subresource)
					assert.Equal(t, "invalid org", reason, "verb: %s%s", read.verb, read.subresource)
				}
			})

			t.Run("another organization's namespace is denied even with playlist permissions", func(t *testing.T) {
				// The organization boundary precedes permission evaluation: a grant that would
				// satisfy playlists:read in the caller's own organization must not carry over
				// into someone else's namespace.
				chain := newChain(t, true, true)
				for _, read := range reads {
					decision, reason, err := chain.Authorize(ctx,
						playlistAttributes(anonymous, version, foreignNamespace, read.verb, read.name, read.subresource))
					require.NoError(t, err)
					assert.Equal(t, authorizer.DecisionDeny, decision, "verb: %s%s", read.verb, read.subresource)
					assert.Equal(t, "invalid org", reason, "verb: %s%s", read.verb, read.subresource)
				}
			})

			t.Run("its own organization is still readable", func(t *testing.T) {
				// Scoping the anonymous identity must not take away the access it is configured
				// for, or anonymous viewing breaks.
				chain := newChain(t, false, false)
				for _, read := range reads {
					decision, _, err := chain.Authorize(ctx,
						playlistAttributes(anonymous, version, ownNamespace, read.verb, read.name, read.subresource))
					require.NoError(t, err)
					assert.Equal(t, authorizer.DecisionAllow, decision, "verb: %s%s", read.verb, read.subresource)
				}
			})

			t.Run("writes in its own organization stay denied", func(t *testing.T) {
				chain := newChain(t, false, false)
				for _, verb := range []string{"create", "update", "patch", "delete", "deletecollection"} {
					decision, _, err := chain.Authorize(ctx,
						playlistAttributes(anonymous, version, ownNamespace, verb, "", ""))
					require.NoError(t, err)
					assert.Equal(t, authorizer.DecisionDeny, decision, "verb: %s", verb)
				}
			})

			t.Run("the None role read grant cannot escape the organization", func(t *testing.T) {
				chain := newChain(t, false, false)
				noneCtx := identity.WithRequester(context.Background(), anonymousNone)
				for _, read := range reads {
					decision, reason, err := chain.Authorize(noneCtx,
						playlistAttributes(anonymousNone, version, foreignNamespace, read.verb, read.name, read.subresource))
					require.NoError(t, err)
					assert.Equal(t, authorizer.DecisionDeny, decision, "verb: %s%s", read.verb, read.subresource)
					assert.Equal(t, "invalid org", reason, "verb: %s%s", read.verb, read.subresource)
				}
				// In its own organization that grant still applies, so the deny above is the
				// namespace boundary and not a loss of the hotfix.
				decision, _, err := chain.Authorize(noneCtx,
					playlistAttributes(anonymousNone, version, ownNamespace, "list", "", ""))
				require.NoError(t, err)
				assert.Equal(t, authorizer.DecisionAllow, decision)
			})

			t.Run("grafana admins keep their cross-organization access", func(t *testing.T) {
				// The namespace authorizer grants server admins any valid namespace on purpose;
				// scoping anonymous identities must not narrow that.
				chain := newChain(t, false, false)
				adminCtx := identity.WithRequester(context.Background(), grafanaAdmin)
				decision, _, err := chain.Authorize(adminCtx,
					playlistAttributes(grafanaAdmin, version, foreignNamespace, "list", "", ""))
				require.NoError(t, err)
				assert.Equal(t, authorizer.DecisionAllow, decision)
			})
		})
	}
}
