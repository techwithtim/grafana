package clients

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/mail"
	"strconv"

	"go.opentelemetry.io/otel/trace"

	claims "github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/services/authn"
	"github.com/grafana/grafana/pkg/services/login"
	"github.com/grafana/grafana/pkg/services/org"
	"github.com/grafana/grafana/pkg/services/user"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/grafana/grafana/pkg/util"
)

var _ authn.ProxyClient = new(Grafana)
var _ authn.PasswordClient = new(Grafana)

// Fixed inputs used to pay the password-hashing cost when a login does not resolve to a
// user, so that the failed-authentication path costs the same whether or not the login
// exists. Only their sizes matter, and those mirror real stored credentials so the work is
// identical: user salts are util.GetRandomString(10) and a stored hash is
// util.EncodePassword's 50 bytes hex-encoded, which keeps subtle.ConstantTimeCompare
// comparing equal-length inputs. Their contents are deliberately uniform placeholders,
// derived from no password and matching no user: the comparison result is discarded and
// the not-found error is returned regardless. They are constants because
// AuthenticatePassword runs concurrently for every request.
const (
	decoySalt = "0000000000"
	decoyHash = "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
)

func ProvideGrafana(cfg *setting.Cfg, userService user.Service, tracer trace.Tracer) *Grafana {
	return &Grafana{cfg, userService, tracer}
}

type Grafana struct {
	cfg         *setting.Cfg
	userService user.Service
	tracer      trace.Tracer
}

func (c *Grafana) String() string {
	return "grafana"
}

func (c *Grafana) AuthenticateProxy(ctx context.Context, r *authn.Request, username string, additional map[string]string) (*authn.Identity, error) {
	ctx, span := c.tracer.Start(ctx, "authn.grafana.AuthenticateProxy") //nolint:ineffassign,staticcheck
	defer span.End()

	identity := &authn.Identity{
		AuthenticatedBy: login.AuthProxyAuthModule,
		AuthID:          username,
		ClientParams: authn.ClientParams{
			SyncUser:        true,
			SyncTeams:       true,
			FetchSyncedUser: true,
			SyncOrgRoles:    true,
			SyncPermissions: true,
			AllowSignUp:     c.cfg.AuthProxy.AutoSignUp,
		},
	}

	switch c.cfg.AuthProxy.HeaderProperty {
	case "username":
		identity.Login = username
		addr, err := mail.ParseAddress(username)
		if err == nil {
			identity.Email = addr.Address
		}
	case "email":
		identity.Login = username
		identity.Email = username
	default:
		return nil, errInvalidProxyHeader.Errorf("invalid auth proxy header property, expected username or email but got: %s", c.cfg.AuthProxy.HeaderProperty)
	}

	if v, ok := additional[proxyFieldName]; ok {
		identity.Name = v
	}

	if v, ok := additional[proxyFieldEmail]; ok {
		identity.Email = v
	}

	if v, ok := additional[proxyFieldLogin]; ok {
		identity.Login = v
	}

	if v, ok := additional[proxyFieldRole]; ok {
		orgRoles, isGrafanaAdmin, _ := getRoles(c.cfg, func() (org.RoleType, *bool, error) {
			return org.RoleType(v), nil, nil
		})
		identity.OrgRoles = orgRoles
		identity.IsGrafanaAdmin = isGrafanaAdmin
	}

	if v, ok := additional[proxyFieldGroups]; ok {
		identity.ExternalGroups = util.SplitString(v)
	}

	identity.ClientParams.LookUpParams.Email = &identity.Email
	identity.ClientParams.LookUpParams.Login = &identity.Login

	return identity, nil
}

func (c *Grafana) AuthenticatePassword(ctx context.Context, r *authn.Request, username, password string) (*authn.Identity, error) {
	ctx, span := c.tracer.Start(ctx, "authn.grafana.AuthenticatePassword")
	defer span.End()

	usr, err := c.userService.GetByLoginWithPassword(ctx, &user.GetUserByLoginQuery{LoginOrEmail: username})
	if err != nil {
		if errors.Is(err, user.ErrUserNotFound) {
			// The password hash comparison below dominates the cost of an authentication
			// attempt, so returning here without performing it would make a failed attempt
			// measurably faster for a login that does not exist than for one that does,
			// disclosing which logins exist. Spend the same cost on decoy inputs; the
			// result is deliberately unused and the outcome is unchanged.
			_ = comparePassword(password, decoySalt, decoyHash)
			return nil, errIdentityNotFound.Errorf("no user found: %w", err)
		}
		return nil, err
	}

	// user was found so set auth module in req metadata
	r.SetMeta(authn.MetaKeyAuthModule, "grafana")

	if ok := comparePassword(password, usr.Salt, string(usr.Password)); !ok {
		return nil, errInvalidPassword.Errorf("invalid password")
	}

	return &authn.Identity{
		ID:              strconv.FormatInt(usr.ID, 10),
		Type:            claims.TypeUser,
		OrgID:           r.OrgID,
		ClientParams:    authn.ClientParams{FetchSyncedUser: true, SyncPermissions: true},
		AuthenticatedBy: login.PasswordAuthModule,
	}, nil
}

func comparePassword(password, salt, hash string) bool {
	// It is ok to ignore the error here because util.EncodePassword can never return a error
	hashedPassword, _ := util.EncodePassword(password, salt)
	return subtle.ConstantTimeCompare([]byte(hashedPassword), []byte(hash)) == 1
}
