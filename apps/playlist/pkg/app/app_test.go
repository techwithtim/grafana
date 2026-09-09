package app

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/util/validation/field"
)

// The fixtures this file builds on -- itemFixture, playlistBuilders and describeErrors -- live
// in conversion_test.go, in this same package.

// uidItem is a valid dashboard_by_uid item carrying the given variables, which is the only
// item shape these size rules can be exercised through.
func uidItem(variables map[string][]string) itemFixture {
	return itemFixture{itemType: "dashboard_by_uid", value: "xCmMwXdVz", variables: variables}
}

// variablesOf returns a map of count variables, each with one value, with names that sort
// stably so an expected cause order can be written down.
func variablesOf(count int) map[string][]string {
	variables := make(map[string][]string, count)
	for i := range count {
		variables[string(rune('a'+i%26))+strings.Repeat("x", i/26)] = []string{"v"}
	}
	return variables
}

// valuesOf returns a list of count distinct values.
func valuesOf(count int) []string {
	values := make([]string, 0, count)
	for i := range count {
		values = append(values, strings.Repeat("v", 1+i%3))
	}
	return values
}

func TestValidatePlaylistObjectVariableMaxima(t *testing.T) {
	// The maxima are the ones the editor and playback apply, so a payload exactly at each
	// maximum has to be admitted: a map the editor commits must be a map the API stores.
	for _, tc := range []struct {
		name  string
		items []itemFixture
		want  []string
	}{
		{
			name:  "variables at the item maximum",
			items: []itemFixture{uidItem(variablesOf(maxVariablesPerItem))},
			want:  []string{},
		},
		{
			name:  "one variable past the item maximum",
			items: []itemFixture{uidItem(variablesOf(maxVariablesPerItem + 1))},
			// One cause for the whole map, not one per name: see validatePlaylistItemVariables.
			want: []string{"FieldValueTooMany spec.items[0].variables"},
		},
		{
			name:  "values at the per-variable maximum",
			items: []itemFixture{uidItem(map[string][]string{"host": valuesOf(maxValuesPerVariable)})},
			want:  []string{},
		},
		{
			name:  "one value past the per-variable maximum",
			items: []itemFixture{uidItem(map[string][]string{"host": valuesOf(maxValuesPerVariable + 1)})},
			want:  []string{"FieldValueTooMany spec.items[0].variables[host]"},
		},
		{
			name:  "name at the length maximum",
			items: []itemFixture{uidItem(map[string][]string{strings.Repeat("n", maxVariableNameLength): {"v"}})},
			want:  []string{},
		},
		{
			name:  "name one code point past the length maximum",
			items: []itemFixture{uidItem(map[string][]string{strings.Repeat("n", maxVariableNameLength+1): {"v"}})},
			want:  []string{"FieldValueTooLong spec.items[0].variables[" + strings.Repeat("n", maxVariableNameLength) + elidedNameSuffix + "]"},
		},
		{
			name:  "value at the length maximum",
			items: []itemFixture{uidItem(map[string][]string{"host": {strings.Repeat("v", maxVariableValueLength)}})},
			want:  []string{},
		},
		{
			name:  "value one code point past the length maximum",
			items: []itemFixture{uidItem(map[string][]string{"host": {strings.Repeat("v", maxVariableValueLength+1)}})},
			want:  []string{"FieldValueTooLong spec.items[0].variables[host][0]"},
		},
		{
			name: "an astral name is measured in code points, not UTF-16 units or bytes",
			// 128 emoji are 128 code points and 512 bytes. Counting bytes would refuse a name
			// the editor accepts, and counting UTF-16 units would refuse it at half the limit.
			items: []itemFixture{uidItem(map[string][]string{strings.Repeat("\U0001F600", maxVariableNameLength): {"v"}})},
			want:  []string{},
		},
		{
			name:  "an astral value is measured in code points too",
			items: []itemFixture{uidItem(map[string][]string{"host": {strings.Repeat("\U0001F600", maxVariableValueLength)}})},
			want:  []string{},
		},
		{
			name: "one over in every dimension at once",
			items: []itemFixture{uidItem(map[string][]string{
				"host": valuesOf(maxValuesPerVariable + 1),
				"zone": {strings.Repeat("v", maxVariableValueLength+1)},
				strings.Repeat("n", maxVariableNameLength+1): {"v"},
			})},
			// Sorted by name, so host precedes the over-long name of "n"s, which precedes zone.
			want: []string{
				"FieldValueTooMany spec.items[0].variables[host]",
				"FieldValueTooLong spec.items[0].variables[" + strings.Repeat("n", maxVariableNameLength) + elidedNameSuffix + "]",
				"FieldValueTooLong spec.items[0].variables[zone][0]",
			},
		},
		{
			name: "each item is bounded on its own",
			items: []itemFixture{
				uidItem(map[string][]string{"host": {"a"}}),
				uidItem(variablesOf(maxVariablesPerItem + 1)),
			},
			want: []string{"FieldValueTooMany spec.items[1].variables"},
		},
	} {
		for _, builder := range playlistBuilders {
			t.Run(tc.name+"/"+builder.version, func(t *testing.T) {
				got := describeErrors(ValidatePlaylistObject(builder.build("test-playlist", tc.items)))
				if len(got) != len(tc.want) {
					t.Fatalf("ValidatePlaylistObject() = %v, want %v", got, tc.want)
				}
				for i := range got {
					if got[i] != tc.want[i] {
						t.Errorf("ValidatePlaylistObject()[%d] = %q, want %q", i, got[i], tc.want[i])
					}
				}
			})
		}
	}
}

func TestValidatePlaylistObjectKeepsARefusalSmall(t *testing.T) {
	// The response to a hostile write must not be a second allocation problem: a map of five
	// thousand names, a five-megabyte name and a five-megabyte value each have to be refused
	// without the refusal carrying what was sent.
	oversized := strings.Repeat("X", 5*1024*1024)

	t.Run("a wide map costs one cause and no member inspection", func(t *testing.T) {
		// Every member is invalid as well (empty value lists), so a validator that walked them
		// would produce five thousand causes rather than one.
		variables := make(map[string][]string, 5000)
		for i := range 5000 {
			variables[strings.Repeat("k", i%64+1)+string(rune('a'+i%26))] = nil
		}
		errs := ValidatePlaylistObject(playlistBuilders[0].build("test-playlist", []itemFixture{uidItem(variables)}))
		if len(errs) != 1 {
			t.Fatalf("len(errs) = %d, want 1", len(errs))
		}
		if got, want := errs[0].Field, "spec.items[0].variables"; got != want {
			t.Errorf("errs[0].Field = %q, want %q", got, want)
		}
		if got, want := errs[0].Type, field.ErrorTypeTooMany; got != want {
			t.Errorf("errs[0].Type = %q, want %q", got, want)
		}
	})

	t.Run("an over-long name is neither echoed nor put in the field path whole", func(t *testing.T) {
		errs := ValidatePlaylistObject(playlistBuilders[0].build("test-playlist",
			[]itemFixture{uidItem(map[string][]string{oversized: {"v"}})}))
		if len(errs) != 1 {
			t.Fatalf("len(errs) = %d, want 1 (%v)", len(errs), describeErrors(errs))
		}
		if got, ok := errs[0].BadValue.(string); !ok || strings.Contains(got, "XXXXXXXXXXXX") {
			t.Errorf("errs[0].BadValue = %.40v, want the value omitted", errs[0].BadValue)
		}
		// The path holds the cut name and the marker, and nothing more: 128 code points plus
		// the three-character marker, whatever was sent.
		if got, want := len(errs[0].Field), len("spec.items[0].variables[]")+maxVariableNameLength+len(elidedNameSuffix); got != want {
			t.Errorf("len(errs[0].Field) = %d, want %d", got, want)
		}
		if !strings.HasSuffix(errs[0].Field, elidedNameSuffix+"]") {
			t.Errorf("errs[0].Field = %q, want it to end in the elision marker", errs[0].Field)
		}
	})

	t.Run("an over-long value is not echoed", func(t *testing.T) {
		errs := ValidatePlaylistObject(playlistBuilders[0].build("test-playlist",
			[]itemFixture{uidItem(map[string][]string{"host": {oversized}})}))
		if len(errs) != 1 {
			t.Fatalf("len(errs) = %d, want 1 (%v)", len(errs), describeErrors(errs))
		}
		if got, want := errs[0].Field, "spec.items[0].variables[host][0]"; got != want {
			t.Errorf("errs[0].Field = %q, want %q", got, want)
		}
		if got, ok := errs[0].BadValue.(string); !ok || strings.Contains(got, "XXXXXXXXXXXX") {
			t.Errorf("errs[0].BadValue = %.40v, want the value omitted", errs[0].BadValue)
		}
		if !strings.Contains(errs[0].Detail, "1024") {
			t.Errorf("errs[0].Detail = %q, want it to state the maximum", errs[0].Detail)
		}
	})
}

func TestValidatePlaylistObjectBlankVariableNames(t *testing.T) {
	// One rule for what an empty name is, shared with the browser: whitespace, invisible
	// (Unicode format) and control characters carry no name. isBlankVariableName in
	// public/app/features/playlist/variableLimits.ts answers identically for every case here.
	for _, tc := range []struct {
		name     string
		variable string
		blank    bool
	}{
		{name: "empty", variable: "", blank: true},
		{name: "space", variable: " ", blank: true},
		{name: "tab", variable: "\t", blank: true},
		{name: "vertical tab", variable: "\v", blank: true},
		{name: "newline", variable: "\n", blank: true},
		{name: "no-break space U+00A0", variable: "\u00a0", blank: true},
		{name: "next line U+0085", variable: "\u0085", blank: true},
		{name: "soft hyphen U+00AD", variable: "\u00ad", blank: true},
		{name: "zero width space U+200B", variable: "\u200b", blank: true},
		{name: "zero width non-joiner U+200C", variable: "\u200c", blank: true},
		{name: "left-to-right mark U+200E", variable: "\u200e", blank: true},
		{name: "right-to-left override U+202E", variable: "\u202e", blank: true},
		{name: "word joiner U+2060", variable: "\u2060", blank: true},
		{name: "byte order mark U+FEFF", variable: "\ufeff", blank: true},
		{name: "ideographic space U+3000", variable: "\u3000", blank: true},
		{name: "nul", variable: "\x00", blank: true},
		{name: "mixed invisibles", variable: "\u200b \ufeff\t\u00ad", blank: true},
		{name: "ordinary name", variable: "host", blank: false},
		{name: "name padded with spaces", variable: " host ", blank: false},
		{name: "name that only starts invisible", variable: "\u200bhost", blank: false},
		{name: "single dot", variable: ".", blank: false},
		{name: "astral character", variable: "\U0001F600", blank: false},
		{name: "combining acute U+0301", variable: "\u0301", blank: false},
	} {
		for _, builder := range playlistBuilders {
			t.Run(tc.name+"/"+builder.version, func(t *testing.T) {
				if got := isBlankVariableName(tc.variable); got != tc.blank {
					t.Errorf("isBlankVariableName(%q) = %v, want %v", tc.variable, got, tc.blank)
				}

				errs := ValidatePlaylistObject(builder.build("test-playlist",
					[]itemFixture{uidItem(map[string][]string{tc.variable: {"v"}})}))
				if !tc.blank {
					if len(errs) != 0 {
						t.Fatalf("ValidatePlaylistObject() = %v, want no violation", describeErrors(errs))
					}
					return
				}
				if len(errs) != 1 {
					t.Fatalf("ValidatePlaylistObject() = %v, want one violation", describeErrors(errs))
				}
				if got, want := errs[0].Type, field.ErrorTypeInvalid; got != want {
					t.Errorf("errs[0].Type = %q, want %q", got, want)
				}
				if got, want := errs[0].Field, "spec.items[0].variables["+tc.variable+"]"; got != want {
					t.Errorf("errs[0].Field = %q, want %q", got, want)
				}
			})
		}
	}
}

func TestWithinCodePointLimit(t *testing.T) {
	// The Go half of isWithinCodePointLimit in variableLimits.ts, and the reason a name of
	// astral characters is not charged twice for each of them.
	for _, tc := range []struct {
		name  string
		text  string
		limit int
		want  bool
	}{
		{name: "empty", text: "", limit: 0, want: true},
		{name: "under", text: "abc", limit: 4, want: true},
		{name: "exactly", text: "abcd", limit: 4, want: true},
		{name: "over", text: "abcde", limit: 4, want: false},
		{name: "astral exactly", text: "\U0001F600\U0001F600", limit: 2, want: true},
		{name: "astral over", text: "\U0001F600\U0001F600\U0001F600", limit: 2, want: false},
		{name: "multi-byte under the byte count", text: "\u00e9\u00e9", limit: 2, want: true},
		{name: "far over", text: strings.Repeat("x", 1024), limit: 4, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := withinCodePointLimit(tc.text, tc.limit); got != tc.want {
				t.Errorf("withinCodePointLimit(%.10q, %d) = %v, want %v", tc.text, tc.limit, got, tc.want)
			}
		})
	}
}

func TestTruncateToCodePoints(t *testing.T) {
	// A cut name goes into a field path, so it has to stay valid UTF-8: cutting by bytes
	// would leave half a character there.
	for _, tc := range []struct {
		name  string
		text  string
		limit int
		want  string
	}{
		{name: "shorter than the limit", text: "abc", limit: 8, want: "abc"},
		{name: "exactly the limit", text: "abc", limit: 3, want: "abc"},
		{name: "cut", text: "abcdef", limit: 3, want: "abc"},
		{name: "cut between astral characters", text: "\U0001F600\U0001F600\U0001F600", limit: 2, want: "\U0001F600\U0001F600"},
		{name: "cut to nothing", text: "abc", limit: 0, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := truncateToCodePoints(tc.text, tc.limit)
			if got != tc.want {
				t.Errorf("truncateToCodePoints(%q, %d) = %q, want %q", tc.text, tc.limit, got, tc.want)
			}
			if len([]rune(got)) > tc.limit {
				t.Errorf("truncateToCodePoints(%q, %d) returned %d code points", tc.text, tc.limit, len([]rune(got)))
			}
		})
	}
}
