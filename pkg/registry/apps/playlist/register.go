package playlist

import (
	"context"
	"fmt"
	"io"

	"k8s.io/apiserver/pkg/admission"
	"k8s.io/apiserver/pkg/authorization/authorizer"
	restclient "k8s.io/client-go/rest"

	"github.com/grafana/grafana-app-sdk/app"
	appsdkapiserver "github.com/grafana/grafana-app-sdk/k8s/apiserver"
	"github.com/grafana/grafana-app-sdk/simple"
	"github.com/open-feature/go-sdk/openfeature"

	"github.com/grafana/grafana/apps/playlist/pkg/apis/manifestdata"
	playlistapp "github.com/grafana/grafana/apps/playlist/pkg/app"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/services/accesscontrol"
	"github.com/grafana/grafana/pkg/services/featuremgmt"
	"github.com/grafana/grafana/pkg/services/org"
	"github.com/grafana/grafana/pkg/setting"
)

var (
	_ appsdkapiserver.AppInstaller = (*AppInstaller)(nil)
)

type AppInstaller struct {
	appsdkapiserver.AppInstaller
	accessControl accesscontrol.AccessControl
	logger        log.Logger
}

func RegisterAppInstaller(
	cfg *setting.Cfg,
	accessControlService accesscontrol.Service,
	ac accesscontrol.AccessControl,
) (*AppInstaller, error) {
	if err := DeclareFixedRoles(accessControlService); err != nil {
		return nil, fmt.Errorf("declaring fixed roles: %w", err)
	}

	installer := &AppInstaller{
		accessControl: ac,
		logger:        log.New("playlist.api"),
	}
	specificConfig := any(&playlistapp.PlaylistConfig{
		EnableReconcilers: cfg.EnablePlaylistsReconciler,
	})
	provider := simple.NewAppProvider(manifestdata.LocalManifest(), specificConfig, playlistapp.New)

	appConfig := app.Config{
		KubeConfig:     restclient.Config{}, // this will be overridden by the installer's InitializeApp method
		ManifestData:   *manifestdata.LocalManifest().ManifestData,
		SpecificConfig: specificConfig,
	}
	i, err := appsdkapiserver.NewDefaultAppInstaller(provider, appConfig, &manifestdata.GoTypeAssociator{})
	if err != nil {
		return nil, err
	}
	installer.AppInstaller = i

	return installer, nil
}

func (p *AppInstaller) GetAuthorizer() authorizer.Authorizer {
	return authorizer.AuthorizerFunc(
		func(ctx context.Context, attr authorizer.Attributes) (authorizer.Decision, string, error) {
			if !attr.IsResourceRequest() {
				return authorizer.DecisionNoOpinion, "", nil
			}

			user, err := identity.GetRequester(ctx)
			if err != nil {
				return authorizer.DecisionDeny, "valid user is required", err
			}

			if !openfeature.NewDefaultClient().Boolean(ctx, featuremgmt.FlagPlaylistsRBAC, false, openfeature.TransactionContext(ctx)) {
				// Hotfix: grant None-role users viewer-level access until the toggle is enabled.
				// All other roles are handled by the default role authorizer.
				if user.GetOrgRole() != org.RoleNone {
					return authorizer.DecisionNoOpinion, "", nil
				}
				switch attr.GetVerb() {
				case "get", "list", "watch":
					return authorizer.DecisionAllow, "", nil
				default:
					return authorizer.DecisionNoOpinion, "", nil
				}
			}

			var action string
			switch attr.GetVerb() {
			case "get", "list", "watch":
				action = ActionPlaylistsRead
			case "create", "update", "patch", "delete", "deletecollection":
				action = ActionPlaylistsWrite
			default:
				return authorizer.DecisionDeny, "unsupported verb: " + attr.GetVerb(), nil
			}

			hasAccess, err := p.accessControl.Evaluate(ctx, user, accesscontrol.EvalPermission(action))
			if err != nil {
				p.logger.Error("failed to evaluate permission", "error", err)
				return authorizer.DecisionDeny, "permission evaluation failed", err
			}
			if !hasAccess {
				return authorizer.DecisionDeny, "insufficient permissions", nil
			}

			return authorizer.DecisionAllow, "", nil
		},
	)
}

// AdmissionPlugin wraps the App SDK's admission plugin so that a playlist write which
// violates the item contract published in the generated OpenAPI document -- `required:
// [type, value]`, the three-value `type` enum and `variables` as a map of non-empty string
// lists -- is rejected with HTTP 422 Invalid instead of being persisted.
//
// Why the validation is invoked here as well as in apps/playlist/pkg/app/app.go, which is
// not obvious: Grafana calls AdmissionPlugin once and puts the result into an
// admission.NewChainHandler, whose Validate returns each handler's error verbatim. The SDK's
// own plugin, however, passes every error the app's validator returns through
// admission.NewForbidden, and the apiserver re-wraps anything that is not already Forbidden
// -- so an error raised inside the app can only ever reach the client as HTTP 403 with its
// field causes flattened into a message string. Running the same validation ahead of the
// delegate here is what preserves the Invalid status and its per-field Details.Causes. The
// call in app.go still covers wrappers that are not this apiserver (an operator or webhook
// deployment), so neither call is redundant and neither should be deleted as duplication.
//
// The admission chain is shared with every other app installer, so this handler is consulted
// for other groups' resources too. playlistapp.ValidatePlaylistObject returns nil for any
// object that is not a Playlist, which is what makes those calls a cheap no-op; no second
// group check is added here, because it could drift from the type switch that actually
// decides.
func (p *AppInstaller) AdmissionPlugin() admission.Factory {
	delegateFactory := p.AppInstaller.AdmissionPlugin()
	if delegateFactory == nil {
		// The App SDK returns a nil factory only for a manifest that declares neither
		// validation nor mutation; the playlist manifest declares both, so there is a
		// delegate to wrap in practice.
		return nil
	}

	return func(config io.Reader) (admission.Interface, error) {
		delegate, err := delegateFactory(config)
		if err != nil {
			return nil, fmt.Errorf("creating the app sdk admission plugin for playlists: %w", err)
		}
		return &playlistAdmission{delegate: delegate}, nil
	}
}

// playlistAdmission enforces the structural playlist item contract and then hands the
// request to the App SDK's admission handler.
type playlistAdmission struct {
	// delegate is the App SDK handler. It is never nil in practice; the nil checks below
	// keep a future SDK change from turning a missing handler into a panic that would take
	// every resource write in the aggregated apiserver down with it.
	delegate admission.Interface
}

// All three interfaces are implemented, and each one delegates, because the admission chain
// type-asserts for MutationInterface and ValidationInterface separately and silently skips a
// handler that does not implement the one it is looking for. A wrapper that dropped Admit
// would therefore disable the app's mutation hook without any error.
var (
	_ admission.Interface           = (*playlistAdmission)(nil)
	_ admission.MutationInterface   = (*playlistAdmission)(nil)
	_ admission.ValidationInterface = (*playlistAdmission)(nil)
)

func (p *playlistAdmission) Handles(operation admission.Operation) bool {
	if p.delegate == nil {
		// Without a delegate the wrapper must still be consulted for the operations its own
		// validation covers, which are exactly the ones the playlist manifest declares.
		return operation == admission.Create || operation == admission.Update
	}
	return p.delegate.Handles(operation)
}

func (p *playlistAdmission) Admit(ctx context.Context, a admission.Attributes, o admission.ObjectInterfaces) error {
	mutator, ok := p.delegate.(admission.MutationInterface)
	if !ok {
		return nil
	}
	return mutator.Admit(ctx, a, o)
}

func (p *playlistAdmission) Validate(ctx context.Context, a admission.Attributes, o admission.ObjectInterfaces) error {
	obj := a.GetObject()
	if errs := playlistapp.ValidatePlaylistObject(obj); len(errs) > 0 {
		return playlistapp.NewPlaylistInvalidError(obj, errs)
	}

	validator, ok := p.delegate.(admission.ValidationInterface)
	if !ok {
		return nil
	}
	return validator.Validate(ctx, a, o)
}
