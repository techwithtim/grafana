package clients

import (
	"context"
	"math"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/infra/tracing"
	"github.com/grafana/grafana/pkg/services/authn"
	"github.com/grafana/grafana/pkg/services/login"
	"github.com/grafana/grafana/pkg/services/org"
	"github.com/grafana/grafana/pkg/services/user"
	"github.com/grafana/grafana/pkg/services/user/usertest"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/grafana/grafana/pkg/util"
)

func TestGrafana_AuthenticateProxy(t *testing.T) {
	type testCase struct {
		desc             string
		req              *authn.Request
		username         string
		proxyProperty    string
		additional       map[string]string
		expectedErr      error
		expectedIdentity *authn.Identity
	}

	tests := []testCase{
		{
			desc:          "expect valid identity",
			username:      "test",
			req:           &authn.Request{HTTPRequest: &http.Request{}},
			proxyProperty: "username",
			additional: map[string]string{
				proxyFieldName:   "name",
				proxyFieldRole:   "Viewer",
				proxyFieldGroups: "grp1,grp2",
				proxyFieldEmail:  "email@example.com",
			},
			expectedIdentity: &authn.Identity{
				OrgRoles:        map[int64]org.RoleType{1: org.RoleViewer},
				Login:           "test",
				Name:            "name",
				Email:           "email@example.com",
				AuthenticatedBy: login.AuthProxyAuthModule,
				AuthID:          "test",
				ExternalGroups:  []string{"grp1", "grp2"},
				ClientParams: authn.ClientParams{
					SyncUser:        true,
					SyncTeams:       true,
					AllowSignUp:     true,
					FetchSyncedUser: true,
					SyncOrgRoles:    true,
					LookUpParams: login.UserLookupParams{
						Email: new("email@example.com"),
						Login: new("test"),
					},
				},
			},
		},
		{
			desc:       "should set email as both email and login when configured proxy auth header property is email",
			username:   "test@test.com",
			req:        &authn.Request{HTTPRequest: &http.Request{Header: map[string][]string{}}},
			additional: map[string]string{},
			expectedIdentity: &authn.Identity{
				Login:           "test@test.com",
				Email:           "test@test.com",
				AuthenticatedBy: login.AuthProxyAuthModule,
				AuthID:          "test@test.com",
				ClientParams: authn.ClientParams{
					SyncUser:     true,
					SyncTeams:    true,
					AllowSignUp:  true,
					SyncOrgRoles: true,
					LookUpParams: login.UserLookupParams{
						Email: new("test@test.com"),
						Login: new("test@test.com"),
					},
				},
			},
			proxyProperty: "email",
		},
		{
			desc:          "should return error on invalid auth proxy header property",
			req:           &authn.Request{HTTPRequest: &http.Request{Header: map[string][]string{}}},
			proxyProperty: "other",
			expectedErr:   errInvalidProxyHeader,
		},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			cfg := setting.NewCfg()
			cfg.AuthProxy.AutoSignUp = true
			cfg.AuthProxy.HeaderProperty = tt.proxyProperty
			c := ProvideGrafana(cfg, usertest.NewUserServiceFake(), tracing.InitializeTracerForTest())

			identity, err := c.AuthenticateProxy(context.Background(), tt.req, tt.username, tt.additional)
			assert.ErrorIs(t, err, tt.expectedErr)
			if tt.expectedIdentity != nil {
				assert.Equal(t, tt.expectedIdentity.OrgID, identity.OrgID)
				assert.Equal(t, tt.expectedIdentity.Login, identity.Login)
				assert.Equal(t, tt.expectedIdentity.Name, identity.Name)
				assert.Equal(t, tt.expectedIdentity.Email, identity.Email)
				assert.Equal(t, tt.expectedIdentity.AuthID, identity.AuthID)
				assert.Equal(t, tt.expectedIdentity.AuthenticatedBy, identity.AuthenticatedBy)
				assert.Equal(t, tt.expectedIdentity.ExternalGroups, identity.ExternalGroups)
				assert.Empty(t, identity.Groups, "IdP groups must not leak into Identity.Groups")

				assert.Equal(t, tt.expectedIdentity.ClientParams.SyncUser, identity.ClientParams.SyncUser)
				assert.Equal(t, tt.expectedIdentity.ClientParams.AllowSignUp, identity.ClientParams.AllowSignUp)
				assert.Equal(t, tt.expectedIdentity.ClientParams.SyncTeams, identity.ClientParams.SyncTeams)
				assert.Equal(t, tt.expectedIdentity.ClientParams.EnableUser, identity.ClientParams.EnableUser)

				assert.EqualValues(t, tt.expectedIdentity.ClientParams.LookUpParams.Email, identity.ClientParams.LookUpParams.Email)
				assert.EqualValues(t, tt.expectedIdentity.ClientParams.LookUpParams.Login, identity.ClientParams.LookUpParams.Login)
			} else {
				assert.Nil(t, tt.expectedIdentity)
			}
		})
	}
}

func TestGrafana_AuthenticatePassword(t *testing.T) {
	type testCase struct {
		desc             string
		username         string
		password         string
		findUser         bool
		expectedErr      error
		expectedIdentity *authn.Identity
	}

	tests := []testCase{
		{
			desc:     "should successfully authenticate user with correct password",
			username: "user",
			password: "password",
			findUser: true,
			expectedIdentity: &authn.Identity{
				ID:              "1",
				Type:            claims.TypeUser,
				OrgID:           1,
				AuthenticatedBy: login.PasswordAuthModule,
				ClientParams:    authn.ClientParams{FetchSyncedUser: true, SyncPermissions: true},
			},
		},
		{
			desc:        "should fail for incorrect password",
			username:    "user",
			password:    "wrong",
			findUser:    true,
			expectedErr: errInvalidPassword,
		},
		{
			desc:        "should fail if user is not found",
			username:    "user",
			password:    "password",
			expectedErr: errIdentityNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			hashed, _ := util.EncodePassword("password", "salt")
			userService := &usertest.FakeUserService{
				ExpectedUser: &user.User{ID: 1, Password: user.Password(hashed), Salt: "salt"},
			}

			if !tt.findUser {
				userService.ExpectedUser = nil
				userService.ExpectedError = user.ErrUserNotFound
			}

			c := ProvideGrafana(setting.NewCfg(), userService, tracing.InitializeTracerForTest())
			identity, err := c.AuthenticatePassword(context.Background(), &authn.Request{OrgID: 1}, tt.username, tt.password)
			assert.ErrorIs(t, err, tt.expectedErr)
			assert.EqualValues(t, tt.expectedIdentity, identity)
		})
	}
}

// TestGrafana_AuthenticatePassword_UnknownLoginHashesLikeKnownLogin pins the fix for the
// username-enumeration side channel: the password hash comparison is the dominant cost of
// an authentication attempt, so a login that does not resolve to a user must still pay it,
// otherwise the response time discloses which logins exist.
//
// The measurement is deliberately a LOWER bound and is calibrated against this host: an
// overloaded or slow machine can only make the measured path take longer than the hashing
// work it performs, so a lower bound cannot flake, whereas an upper bound would. Without
// the equalizing comparison the not-found path returns in microseconds - roughly two
// orders of magnitude under the reference - so the assertion genuinely fails on the
// unfixed code.
func TestGrafana_AuthenticatePassword_UnknownLoginHashesLikeKnownLogin(t *testing.T) {
	const (
		password = "password"
		samples  = 5
	)

	// Reference cost of one password hash on this host, produced exactly as the
	// authentication path produces it. The minimum sample is the least load-contaminated.
	reference := time.Duration(math.MaxInt64)
	for range samples {
		start := time.Now()
		_, err := util.EncodePassword(password, decoySalt)
		require.NoError(t, err)
		if elapsed := time.Since(start); elapsed < reference {
			reference = elapsed
		}
	}

	// FakeUserService.GetByLoginWithPassword delegates to GetByLogin, which returns
	// ExpectedUser/ExpectedError, so this drives the user.ErrUserNotFound branch.
	userService := &usertest.FakeUserService{ExpectedError: user.ErrUserNotFound}
	c := ProvideGrafana(setting.NewCfg(), userService, tracing.InitializeTracerForTest())

	durations := make([]time.Duration, 0, samples)
	for range samples {
		start := time.Now()
		identity, err := c.AuthenticatePassword(context.Background(), &authn.Request{OrgID: 1}, "login-that-never-existed", password)
		durations = append(durations, time.Since(start))

		// Equalizing the cost must not change the authentication outcome.
		assert.Nil(t, identity)
		assert.ErrorIs(t, err, errIdentityNotFound)
	}

	slices.Sort(durations)
	median := durations[len(durations)/2]

	// Half the reference absorbs measurement noise while remaining unreachable without
	// actually performing the hash.
	require.GreaterOrEqual(t, median, reference/2,
		"unknown login failed in %s, under half the %s cost of a single password hash: the failure path skips the hash comparison and leaks whether a login exists",
		median, reference)

	// The decoy inputs must stay the size of real stored credentials - salts are
	// util.GetRandomString(10) and stored hashes are util.EncodePassword's 50 bytes
	// hex-encoded - so the hashing and the constant-time comparison do the same amount of
	// work as they do for a login that resolves to a user.
	assert.Len(t, decoySalt, 10)
	hashed, err := util.EncodePassword(password, decoySalt)
	require.NoError(t, err)
	assert.Len(t, decoyHash, len(hashed))
}
