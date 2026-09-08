package app

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/util/validation/field"

	"github.com/grafana/grafana-app-sdk/app"
	playlistv0alpha1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v0alpha1"
	playlistv1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

// This module deliberately requires no assertion library, so the checks below are written with
// the standard library only: the go.mod of apps/playlist stays free of test-only dependencies.

// versionFixture builds admission requests for one served version, so every rule below is
// exercised against both versions through the single shared validator.
type versionFixture struct {
	name string
	// fromJSON decodes a raw spec document, which is how the null cases are expressed: a JSON
	// null map value decodes to a nil slice and a null array element to an empty string, and
	// those are exactly the two values the served schema promises cannot be stored.
	fromJSON func(t *testing.T, rawSpec string) *app.AdmissionRequest
	// fromVariables builds one item per entry, each carrying that entry's variables, which is
	// how the count and length maxima are driven without writing megabytes of JSON.
	fromVariables func(variablesPerItem []map[string][]string) *app.AdmissionRequest
}

func versionFixtures() []versionFixture {
	return []versionFixture{
		{
			name: "v1",
			fromJSON: func(t *testing.T, rawSpec string) *app.AdmissionRequest {
				t.Helper()
				playlist := &playlistv1.Playlist{}
				if err := json.Unmarshal([]byte(rawSpec), &playlist.Spec); err != nil {
					t.Fatalf("could not decode the spec fixture: %v", err)
				}
				return &app.AdmissionRequest{Action: "CREATE", Object: playlist}
			},
			fromVariables: func(variablesPerItem []map[string][]string) *app.AdmissionRequest {
				items := make([]playlistv1.PlaylistItem, len(variablesPerItem))
				for i, variables := range variablesPerItem {
					items[i] = playlistv1.PlaylistItem{
						Type:      playlistv1.PlaylistPlaylistItemTypeDashboardByUid,
						Value:     "xCmMwXdVz",
						Variables: variables,
					}
				}
				return &app.AdmissionRequest{Action: "CREATE", Object: &playlistv1.Playlist{
					Spec: playlistv1.PlaylistSpec{Title: "Test", Interval: "20s", Items: items},
				}}
			},
		},
		{
			name: "v0alpha1",
			fromJSON: func(t *testing.T, rawSpec string) *app.AdmissionRequest {
				t.Helper()
				playlist := &playlistv0alpha1.Playlist{}
				if err := json.Unmarshal([]byte(rawSpec), &playlist.Spec); err != nil {
					t.Fatalf("could not decode the spec fixture: %v", err)
				}
				return &app.AdmissionRequest{Action: "CREATE", Object: playlist}
			},
			fromVariables: func(variablesPerItem []map[string][]string) *app.AdmissionRequest {
				items := make([]playlistv0alpha1.PlaylistItem, len(variablesPerItem))
				for i, variables := range variablesPerItem {
					items[i] = playlistv0alpha1.PlaylistItem{
						Type:      playlistv0alpha1.PlaylistPlaylistItemTypeDashboardByUid,
						Value:     "xCmMwXdVz",
						Variables: variables,
					}
				}
				return &app.AdmissionRequest{Action: "CREATE", Object: &playlistv0alpha1.Playlist{
					Spec: playlistv0alpha1.PlaylistSpec{Title: "Test", Interval: "20s", Items: items},
				}}
			},
		},
	}
}

// singleValues returns count single-valued variables under distinct names.
func singleValues(count int) map[string][]string {
	variables := make(map[string][]string, count)
	for i := range count {
		variables["host-"+strconv.Itoa(i)] = []string{"a"}
	}
	return variables
}

// values returns count distinct values for one variable.
func values(count int) []string {
	out := make([]string, count)
	for i := range out {
		out[i] = "host-" + strconv.Itoa(i)
	}
	return out
}

// variablesForItems repeats one variables map across count items.
func variablesForItems(count int, variables map[string][]string) []map[string][]string {
	items := make([]map[string][]string, count)
	for i := range items {
		items[i] = variables
	}
	return items
}

func assertNoError(t *testing.T, err error, context string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: expected the write to be admitted, got %v", context, err)
	}
}

func assertRejected(t *testing.T, err error, context string, contains []string, notContains []string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: expected the write to be rejected, got no error", context)
	}
	message := err.Error()
	for _, expected := range contains {
		if !strings.Contains(message, expected) {
			t.Errorf("%s: rejection message %q does not name %q", context, message, expected)
		}
	}
	for _, forbidden := range notContains {
		if strings.Contains(message, forbidden) {
			t.Errorf("%s: rejection message must not echo the rejected value", context)
		}
	}
}

func TestValidatePlaylistAdmissionValueContract(t *testing.T) {
	tests := []struct {
		name string
		// rawSpec is a served spec document, decoded into the version's typed spec.
		rawSpec string
		// contains are substrings the rejection must carry; an empty list means the spec is
		// expected to be admitted.
		contains []string
	}{
		{
			name:    "a valid item is admitted",
			rawSpec: `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":["a","b"],"cluster":["c"]}}]}`,
		},
		{
			name:    "an item without variables is admitted",
			rawSpec: `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_tag","value":"graph-ng"}]}`,
		},
		{
			name:    "an explicitly empty variables map is admitted",
			rawSpec: `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{}}]}`,
		},
		{
			name:    "a playlist without items is admitted",
			rawSpec: `{"title":"Test","interval":"20s","items":[]}`,
		},
		{
			name:     "a null value list is rejected",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":null}}]}`,
			contains: []string{"spec.items[0].variables[host]", "at least one value"},
		},
		{
			name:     "an empty value list is rejected",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":[]}}]}`,
			contains: []string{"spec.items[0].variables[host]", "at least one value"},
		},
		{
			name:     "a null array element is rejected",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":[null]}}]}`,
			contains: []string{"spec.items[0].variables[host][0]", "must not be empty"},
		},
		{
			name:     "an empty string element is rejected",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":["a",""]}}]}`,
			contains: []string{"spec.items[0].variables[host][1]", "must not be empty"},
		},
		{
			name:     "an empty variable name is rejected",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"":["a"]}}]}`,
			contains: []string{"spec.items[0].variables", "name is required"},
		},
		{
			name:     "the item index of the offending item is reported",
			rawSpec:  `{"title":"Test","interval":"20s","items":[{"type":"dashboard_by_tag","value":"graph-ng"},{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":null}}]}`,
			contains: []string{"spec.items[1].variables[host]"},
		},
	}

	for _, version := range versionFixtures() {
		for _, tc := range tests {
			t.Run(version.name+"/"+tc.name, func(t *testing.T) {
				err := validatePlaylistAdmission(t.Context(), version.fromJSON(t, tc.rawSpec))
				if len(tc.contains) == 0 {
					assertNoError(t, err, tc.name)
					return
				}
				assertRejected(t, err, tc.name, tc.contains, nil)
			})
		}
	}
}

// The length maxima are counted in Unicode code points, the unit the served schema's maxLength
// uses. These two characters are what proves it: their byte length and their UTF-16 length both
// differ from their code point count, so a validator counting either unit would reject a payload
// at the limit that the schema and the editor accept.
const (
	// U+00E9 LATIN SMALL LETTER E WITH ACUTE: 1 code point, 2 UTF-8 bytes, 1 UTF-16 unit.
	// Written as an escape so the fixture cannot be changed by an editor normalizing the file
	// into the decomposed "e" plus combining acute, which is two code points.
	twoByteChar = "\u00e9"
	// U+1D11E MUSICAL SYMBOL G CLEF: 1 code point, 4 UTF-8 bytes, 2 UTF-16 units.
	astralChar = "\U0001d11e"
)

func TestValidatePlaylistAdmissionMaxima(t *testing.T) {
	for _, char := range []string{twoByteChar, astralChar} {
		// A single-byte fixture would turn the cases below into duplicates of the ASCII ones
		// and stop proving anything about the unit, so it fails the suite instead.
		if utf8.RuneCountInString(char) != 1 || len(char) < 2 {
			t.Fatalf("fixture %q must be exactly one multi-byte code point", char)
		}
	}

	longName := strings.Repeat("n", MaxVariableNameLength+1)
	longValue := strings.Repeat("v", MaxVariableValueLength+1)
	longTwoByteName := strings.Repeat(twoByteChar, MaxVariableNameLength+1)
	longTwoByteValue := strings.Repeat(twoByteChar, MaxVariableValueLength+1)
	longAstralName := strings.Repeat(astralChar, MaxVariableNameLength+1)
	longAstralValue := strings.Repeat(astralChar, MaxVariableValueLength+1)

	tests := []struct {
		name string
		// accepted and rejected are the same payload shape at the limit and one past it, so a
		// limit that drifts in either direction fails here.
		accepted []map[string][]string
		rejected []map[string][]string
		contains []string
		// notContains guards the rule that an over-long name or value is never echoed back.
		notContains []string
	}{
		{
			name:     "item count",
			accepted: variablesForItems(MaxPlaylistItems, nil),
			rejected: variablesForItems(MaxPlaylistItems+1, nil),
			contains: []string{"spec.items", "must have at most 1000 items"},
		},
		{
			name:     "variables per item",
			accepted: []map[string][]string{singleValues(MaxItemVariables)},
			rejected: []map[string][]string{singleValues(MaxItemVariables + 1)},
			contains: []string{"spec.items[0].variables", "must have at most 32 items"},
		},
		{
			name:     "values per variable",
			accepted: []map[string][]string{{"host": values(MaxVariableValues)}},
			rejected: []map[string][]string{{"host": values(MaxVariableValues + 1)}},
			contains: []string{"spec.items[0].variables[host]", "must have at most 64 items"},
		},
		{
			name:        "variable name length",
			accepted:    []map[string][]string{{strings.Repeat("n", MaxVariableNameLength): {"a"}}},
			rejected:    []map[string][]string{{longName: {"a"}}},
			contains:    []string{"spec.items[0].variables", "may not be more than 128 characters"},
			notContains: []string{longName},
		},
		{
			name:        "variable value length",
			accepted:    []map[string][]string{{"host": {strings.Repeat("v", MaxVariableValueLength)}}},
			rejected:    []map[string][]string{{"host": {longValue}}},
			contains:    []string{"spec.items[0].variables[host][0]", "may not be more than 1024 characters"},
			notContains: []string{longValue},
		},
		{
			// 128 two-byte characters are 128 code points and 256 UTF-8 bytes: admitted,
			// because the limit is the schema's, counted in code points.
			name:        "variable name length in two-byte characters",
			accepted:    []map[string][]string{{strings.Repeat(twoByteChar, MaxVariableNameLength): {"a"}}},
			rejected:    []map[string][]string{{longTwoByteName: {"a"}}},
			contains:    []string{"spec.items[0].variables", "may not be more than 128 characters"},
			notContains: []string{longTwoByteName},
		},
		{
			name:        "variable value length in two-byte characters",
			accepted:    []map[string][]string{{"host": {strings.Repeat(twoByteChar, MaxVariableValueLength)}}},
			rejected:    []map[string][]string{{"host": {longTwoByteValue}}},
			contains:    []string{"spec.items[0].variables[host][0]", "may not be more than 1024 characters"},
			notContains: []string{longTwoByteValue},
		},
		{
			// An astral character is one code point but four UTF-8 bytes and two UTF-16
			// units, so these two cases pass only if the unit is code points: a byte count
			// or a UTF-16 count would reject the accepted payload as four times, or twice,
			// over the limit.
			name:        "variable name length in astral characters",
			accepted:    []map[string][]string{{strings.Repeat(astralChar, MaxVariableNameLength): {"a"}}},
			rejected:    []map[string][]string{{longAstralName: {"a"}}},
			contains:    []string{"spec.items[0].variables", "may not be more than 128 characters"},
			notContains: []string{longAstralName},
		},
		{
			name:        "variable value length in astral characters",
			accepted:    []map[string][]string{{"host": {strings.Repeat(astralChar, MaxVariableValueLength)}}},
			rejected:    []map[string][]string{{"host": {longAstralValue}}},
			contains:    []string{"spec.items[0].variables[host][0]", "may not be more than 1024 characters"},
			notContains: []string{longAstralValue},
		},
	}

	for _, version := range versionFixtures() {
		for _, tc := range tests {
			t.Run(version.name+"/"+tc.name+" at the limit", func(t *testing.T) {
				err := validatePlaylistAdmission(t.Context(), version.fromVariables(tc.accepted))
				assertNoError(t, err, tc.name)
			})
			t.Run(version.name+"/"+tc.name+" over the limit", func(t *testing.T) {
				err := validatePlaylistAdmission(t.Context(), version.fromVariables(tc.rejected))
				assertRejected(t, err, tc.name, tc.contains, tc.notContains)
			})
		}
	}
}

func TestValidatePlaylistAdmissionWithoutAnObject(t *testing.T) {
	// Nothing to validate is not a rejection: a delete carries no object, and a nil request
	// or a nil typed object must not panic inside admission either.
	if err := validatePlaylistAdmission(t.Context(), nil); err != nil {
		t.Errorf("a nil request must be admitted, got %v", err)
	}
	if err := validatePlaylistAdmission(t.Context(), &app.AdmissionRequest{Action: "DELETE"}); err != nil {
		t.Errorf("a request without an object must be admitted, got %v", err)
	}
	if err := validatePlaylistAdmission(t.Context(), &app.AdmissionRequest{
		Action: "CREATE",
		Object: (*playlistv1.Playlist)(nil),
	}); err != nil {
		t.Errorf("a nil v1 object must be admitted, got %v", err)
	}
	if err := validatePlaylistAdmission(t.Context(), &app.AdmissionRequest{
		Action: "CREATE",
		Object: (*playlistv0alpha1.Playlist)(nil),
	}); err != nil {
		t.Errorf("a nil v0alpha1 object must be admitted, got %v", err)
	}
}

func TestSpecItemVariables(t *testing.T) {
	expected := []map[string][]string{
		{"host": {"a", "b"}},
		nil,
	}

	v1Spec := playlistv1.PlaylistSpec{Items: []playlistv1.PlaylistItem{
		{Type: playlistv1.PlaylistPlaylistItemTypeDashboardByUid, Value: "xCmMwXdVz", Variables: map[string][]string{"host": {"a", "b"}}},
		{Type: playlistv1.PlaylistPlaylistItemTypeDashboardByTag, Value: "graph-ng"},
	}}
	v0alpha1Spec := playlistv0alpha1.PlaylistSpec{Items: []playlistv0alpha1.PlaylistItem{
		{Type: playlistv0alpha1.PlaylistPlaylistItemTypeDashboardByUid, Value: "xCmMwXdVz", Variables: map[string][]string{"host": {"a", "b"}}},
		{Type: playlistv0alpha1.PlaylistPlaylistItemTypeDashboardByTag, Value: "graph-ng"},
	}}

	// The untyped case is what a write that never materializes a typed object goes through,
	// so it is decoded from a document rather than hand-built.
	untyped := map[string]any{}
	if err := json.Unmarshal([]byte(`{"title":"Test","interval":"20s","items":[
		{"type":"dashboard_by_uid","value":"xCmMwXdVz","variables":{"host":["a","b"]}},
		{"type":"dashboard_by_tag","value":"graph-ng"}]}`), &untyped); err != nil {
		t.Fatalf("could not decode the untyped fixture: %v", err)
	}

	specs := map[string]any{
		"v1 spec":            v1Spec,
		"v1 spec pointer":    &v1Spec,
		"v0alpha1 spec":      v0alpha1Spec,
		"v0alpha1 pointer":   &v0alpha1Spec,
		"untyped spec map":   untyped,
		"untyped spec bytes": json.RawMessage(`{"items":[{"variables":{"host":["a","b"]}},{"type":"dashboard_by_tag"}]}`),
	}
	for name, spec := range specs {
		t.Run(name, func(t *testing.T) {
			items, err := specItemVariables(spec)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(expected, items) {
				t.Errorf("expected %v, got %v", expected, items)
			}
		})
	}

	t.Run("a nil spec has no items", func(t *testing.T) {
		items, err := specItemVariables(nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(items) != 0 {
			t.Errorf("expected no items, got %v", items)
		}
	})

	t.Run("a spec that does not match the schema is an error", func(t *testing.T) {
		// A shape no served schema can produce is refused rather than silently admitted,
		// which is what keeps the JSON fallback from becoming a way around validation.
		_, err := specItemVariables(map[string]any{"items": []any{map[string]any{"variables": "not-a-map"}}})
		if err == nil {
			t.Fatal("expected an error for a spec that does not match the playlist schema")
		}
	})
}

func TestValidateItemVariablesReportsEveryViolationOnce(t *testing.T) {
	// The helper is what the legacy /api/playlists bridge calls with its own path root, so the
	// path it is given is the path it reports, and one call reports every violation it finds.
	errs := ValidateItemVariables(map[string][]string{
		"host":    nil,
		"cluster": {""},
		"region":  {"eu"},
	}, field.NewPath("items").Index(0).Child("variables"))
	if len(errs) != 2 {
		t.Fatalf("expected exactly two violations, got %d: %v", len(errs), errs)
	}
	message := errs.ToAggregate().Error()
	for _, expected := range []string{"items[0].variables[cluster][0]", "items[0].variables[host]"} {
		if !strings.Contains(message, expected) {
			t.Errorf("aggregate %q does not name %q", message, expected)
		}
	}
	if strings.Contains(message, "region") {
		t.Errorf("aggregate %q reports a valid variable", message)
	}
}

func TestValidateItemCountBoundary(t *testing.T) {
	itemsPath := field.NewPath("legacy", "items")
	if errs := ValidateItemCount(MaxPlaylistItems, itemsPath); len(errs) != 0 {
		t.Errorf("a playlist of exactly %d items must be accepted, got %v", MaxPlaylistItems, errs)
	}
	errs := ValidateItemCount(MaxPlaylistItems+1, itemsPath)
	if len(errs) != 1 {
		t.Fatalf("expected one violation, got %v", errs)
	}
	if !strings.Contains(errs[0].Error(), "legacy.items") {
		t.Errorf("violation %q does not use the caller's path", errs[0].Error())
	}
}
