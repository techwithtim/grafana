package app

import (
	"encoding/json"
	"fmt"

	"k8s.io/apimachinery/pkg/conversion"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/grafana/grafana-app-sdk/k8s"
	"github.com/grafana/grafana-app-sdk/simple"
	v0alpha1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v0alpha1"
	v1 "github.com/grafana/grafana/apps/playlist/pkg/apis/playlist/v1"
)

var _ simple.Converter = NewExampleConverter()

type ExampleConverter struct{}

func NewExampleConverter() *ExampleConverter {
	return &ExampleConverter{}
}

// Convert converts an object from an arbitrary input version slice of bytes
// to a target version, and returns the JSON bytes of that version.
func (e *ExampleConverter) Convert(obj k8s.RawKind, targetAPIVersion string) ([]byte, error) {
	srcGVK := schema.FromAPIVersionAndKind(obj.APIVersion, obj.Kind)
	dstGVK := schema.FromAPIVersionAndKind(targetAPIVersion, v1.PlaylistKind().Kind())
	if srcGVK.Group != v1.APIGroup {
		// This should never happen, but check just in case
		return nil, fmt.Errorf("wrong group to convert example.grafana.app, got %s", srcGVK.Group)
	}
	if srcGVK.Kind != v1.PlaylistKind().Kind() {
		// This should also never happen, but check just in case
		return nil, fmt.Errorf("wrong kind to convert Example, got %s", srcGVK.Kind)
	}
	if srcGVK == dstGVK {
		// This should never happen, but if it does no conversion is necessary, we can return the input
		return obj.Raw, nil
	}

	// This conversion is dump... since both objects are identical just remove the apiVersion
	out := &v1.Playlist{}
	err := json.Unmarshal(obj.Raw, out)
	if err != nil {
		return nil, fmt.Errorf("unable to unmarshal JSON bytes into Playlist: %w", err)
	}
	out.APIVersion = "" // empty... filled in later
	return json.Marshal(out)
}

// The group-version-kinds of the two served versions. Both are the identity a converted
// object is stamped with, so they are resolved once from the generated kinds rather than
// spelled out as strings.
var (
	playlistV1GVK       = v1.PlaylistKind().GroupVersionKind()
	playlistV0alpha1GVK = v0alpha1.PlaylistKind().GroupVersionKind()
)

// RegisterConversions registers the conversions the apiserver needs between the Go types of
// the two served Playlist versions. It is called from the app installer's AddToScheme
// (pkg/registry/apps/playlist/register.go) after the App SDK has registered its own, and it
// is safe to call more than once: a conversion is keyed by its (source, destination) Go type
// pair, so a second registration replaces the first rather than adding to it.
//
// Why the SDK's own conversions are not enough. Each of them (grafana-app-sdk
// k8s/apiserver/installer.go:838-881) begins by encoding the source object with a codec
// chosen from that object's *own* apiVersion:
//
//	runtime.Encode(r.codecs.LegacyCodec(aResourceObj.GroupVersionKind().GroupVersion()), aResourceObj)
//
// The apiserver, however, clears apiVersion and kind whenever it converts an object into a
// group's internal hub version (k8s.io/apimachinery runtime/scheme.go, setTargetKind treats
// runtime.APIVersionInternal as a special case), and the SDK registers that hub with the
// preferred version's Go type -- v1 for playlists, from the manifest's PreferredVersion. So
// every conversion whose source is a hub object receives a *v1.Playlist carrying no
// apiVersion, the codec lookup resolves to the empty group-version, and the conversion fails
// with `v1.Playlist is not suitable for converting to [""]`.
//
// Two request paths reach exactly that conversion, and both were broken by it:
//
//   - A write through one version of an object whose metadata.managedFields records an owner
//     in the other version. Structured field management re-expresses the object in every
//     version an owner used, so it converts out of the hub type; when that fails the
//     apiserver logs `[SHOULD NOT HAPPEN] failed to update managedFields` and drops the whole
//     managedFields list (k8s.io/apimachinery util/managedfields/internal/fieldmanager.go,
//     UpdateNoErrors). The loss is permanent: a later plain update of an object with no
//     managed fields deliberately does not start tracking them again.
//   - A server-side apply through either version of an object owned in the other one. The
//     merge result is produced in the hub version and converted back for the response, so the
//     request answered HTTP 500.
//
// The functions registered here convert between the two versions from the typed objects
// alone, so they cannot be affected by TypeMeta the apiserver is free to clear.
func RegisterConversions(scheme *runtime.Scheme) error {
	if scheme == nil {
		return fmt.Errorf("cannot register playlist conversions on a nil scheme")
	}
	if err := scheme.AddConversionFunc((*v0alpha1.Playlist)(nil), (*v1.Playlist)(nil), convertPlaylistV0alpha1ToV1); err != nil {
		return fmt.Errorf("registering the v0alpha1 to v1 playlist conversion: %w", err)
	}
	if err := scheme.AddConversionFunc((*v1.Playlist)(nil), (*v0alpha1.Playlist)(nil), convertPlaylistV1ToV0alpha1); err != nil {
		return fmt.Errorf("registering the v1 to v0alpha1 playlist conversion: %w", err)
	}
	return nil
}

// convertPlaylistV0alpha1ToV1 converts a v0alpha1 Playlist into a v1 Playlist.
//
// The same registration also answers conversions into the group's internal hub version,
// because the hub is registered with the v1 Go type. The scheme decides which of the two
// names the result carries by stamping the target kind itself once this returns, so v1 is the
// only version this function can honestly claim.
func convertPlaylistV0alpha1ToV1(a, b any, _ conversion.Scope) error {
	in, ok := a.(*v0alpha1.Playlist)
	if !ok || in == nil {
		return fmt.Errorf("expected a non-nil *v0alpha1.Playlist to convert, got %T", a)
	}
	out, ok := b.(*v1.Playlist)
	if !ok || out == nil {
		return fmt.Errorf("expected a non-nil *v1.Playlist to convert into, got %T", b)
	}

	// A destination the caller reused must not keep anything of its own: a conversion
	// replaces the object, it does not merge into it.
	*out = v1.Playlist{}
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	if err := copyPlaylistPart(in.Spec, &out.Spec, "spec"); err != nil {
		return err
	}
	if err := copyPlaylistPart(in.Status, &out.Status, "status"); err != nil {
		return err
	}
	out.SetGroupVersionKind(playlistV1GVK)
	return nil
}

// convertPlaylistV1ToV0alpha1 converts a v1 Playlist into a v0alpha1 Playlist. It is also the
// conversion out of the internal hub version, which shares the v1 Go type, and that is the
// direction every path described on RegisterConversions takes.
func convertPlaylistV1ToV0alpha1(a, b any, _ conversion.Scope) error {
	in, ok := a.(*v1.Playlist)
	if !ok || in == nil {
		return fmt.Errorf("expected a non-nil *v1.Playlist to convert, got %T", a)
	}
	out, ok := b.(*v0alpha1.Playlist)
	if !ok || out == nil {
		return fmt.Errorf("expected a non-nil *v0alpha1.Playlist to convert into, got %T", b)
	}

	*out = v0alpha1.Playlist{}
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	if err := copyPlaylistPart(in.Spec, &out.Spec, "spec"); err != nil {
		return err
	}
	if err := copyPlaylistPart(in.Status, &out.Status, "status"); err != nil {
		return err
	}
	out.SetGroupVersionKind(playlistV0alpha1GVK)
	return nil
}

// copyPlaylistPart copies one served version's spec or status onto the other version's, named
// by part so a failure says which half of the object it happened in.
//
// Metadata is deliberately not copied this way: it is the same Go type in both versions
// (metav1.ObjectMeta), so the conversions above deep copy it directly and every field stays
// exactly as it was -- including metadata.managedFields, which is the reason these
// conversions exist.
//
// Spec and status are distinct Go types per version, generated from one CUE definition
// (apps/playlist/kinds/playlist.cue) and therefore structurally identical, field for field and
// JSON name for JSON name. Copying them through their JSON form is complete by construction: a
// field added to the shared definition converts on the day it is generated, with no conversion
// code to update and no way for a field to be silently dropped here. It is the same round trip
// the app's raw-bytes Converter above performs, and strictly less work than the
// encode-convert-decode the App SDK's own conversion did.
func copyPlaylistPart(in any, out any, part string) error {
	raw, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("unable to marshal the playlist %s of %T for conversion: %w", part, in, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("unable to unmarshal the playlist %s into %T for conversion: %w", part, out, err)
	}
	return nil
}
