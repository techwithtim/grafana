package authorizer

import (
	"context"
	"fmt"

	"github.com/grafana/authlib/types"
	"github.com/grafana/grafana/pkg/apimachinery/identity"
	"k8s.io/apiserver/pkg/authorization/authorizer"
)

type namespaceAuthorizer struct {
}

func newNamespaceAuthorizer() *namespaceAuthorizer {
	return &namespaceAuthorizer{}
}

func (auth namespaceAuthorizer) Authorize(ctx context.Context, a authorizer.Attributes) (authorized authorizer.Decision, reason string, err error) {
	ident, err := identity.GetRequester(ctx)
	if err != nil {
		return authorizer.DecisionDeny, "missing auth info", fmt.Errorf("missing auth info: %w", err)
	}

	if !a.IsResourceRequest() {
		return authorizer.DecisionNoOpinion, "", nil
	}

	ns, err := types.ParseNamespace(a.GetNamespace())
	if err != nil {
		// Do not propagate parse errors: the apiserver treats authorizer errors as 500s.
		return authorizer.DecisionDeny, "invalid namespace", nil
	}

	// If we call a cluster resource we delegate to the next authorizer
	if ns.Value == "" {
		return authorizer.DecisionNoOpinion, "", nil
	}

	// An anonymous identity that carries no organization has nothing to scope against, and
	// reaches only the public routes where the API-specific authorizer decides, so it may
	// access any valid namespace. An anonymous identity bound to an organization (the one
	// configured for anonymous access) is scoped by the checks below like every other
	// identity; otherwise it could read another organization's namespace.
	if types.IsIdentityType(ident.GetIdentityType(), types.TypeAnonymous) && ident.GetOrgID() == 0 {
		return authorizer.DecisionNoOpinion, "", nil
	}

	// Grafana Admins can access any valid namespace; skip org scoping.
	if ident.GetIsGrafanaAdmin() {
		return authorizer.DecisionNoOpinion, "", nil
	}

	if ns.OrgID != ident.GetOrgID() {
		return authorizer.DecisionDeny, "invalid org", nil
	}

	if !types.NamespaceMatches(ident.GetNamespace(), a.GetNamespace()) {
		return authorizer.DecisionDeny, "invalid namespace", nil
	}

	return authorizer.DecisionNoOpinion, "", nil
}
