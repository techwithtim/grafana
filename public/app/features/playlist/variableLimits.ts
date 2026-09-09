/**
 * The finite resource budget for the template variables one playlist item may carry, and the pure
 * helpers that apply it.
 *
 * A playlist is stored data that any user with write access to it can shape, so the values reaching
 * the playback URL and the editor's controls are untrusted. Without a stated maximum, one stored
 * object decides how much work a viewer's tab does: how many parameters are percent-encoded into a
 * history entry, and how many React controls the editor builds.
 *
 * The first four numbers below are enforced on both sides. The admission validator in
 * `apps/playlist/pkg/app/app.go` mirrors them exactly — 32 variables for an item, 64 values for a
 * variable, 128 code points for a name, 1024 for a value — and refuses a write that breaks one
 * with HTTP 422 Invalid naming `spec.items[i].variables[name]`, on the resource API and on the
 * legacy `/api/playlists` endpoints alike, which proxy through the same admission chain. So the
 * two layers agree by construction: a map this editor accepts is a map the API stores, and a map
 * the API refuses is one this editor would not have committed. Changing a number here without
 * changing its counterpart there is what breaks that, and is the one edit this file must not
 * receive alone.
 *
 * The last two are the browser's own and have no server counterpart, because neither describes
 * stored data: one bounds the URL this tab pushes and one bounds the text a single input holds.
 *
 * The helpers below stay defensive about a map that exceeds any of it, and must: the maxima are
 * enforced from the moment they were added, not retroactively, so an object written before them —
 * or one whose variables were within the four maxima yet still too large to put in a URL — is
 * something both consumers have to survive. The editor refuses a map it cannot render, and
 * playback applies the pairs that fit and keeps playing rather than expanding whatever it was
 * handed.
 *
 * `PlaylistSrv` is a singleton constructed while its module graph is still loading, so this module
 * imports no React, no `@grafana/ui` and nothing that runs a side effect on import: any of those
 * would be pulled into that construction. `@grafana/data` is the one exception, and has to be —
 * the URL budget below only means anything when it is measured with the same pure serializer that
 * writes the query, in the same form, which `PlaylistSrv` already imports from there.
 */

import { urlUtil } from '@grafana/data';

/**
 * Template variables one playlist item may carry, in the editor, at playback and on a write. The
 * admission validator refuses a wider map (`maxVariablesPerItem`), so a stored item holds more only
 * if it was written before that rule existed.
 */
export const MAX_VARIABLES_PER_ITEM = 32;

/**
 * Values one template variable may carry, in the editor, at playback and on a write. The admission
 * validator refuses a longer list (`maxValuesPerVariable`), so a stored variable holds more only if
 * it was written before that rule existed.
 */
export const MAX_VALUES_PER_VARIABLE = 64;

/**
 * Unicode code points a template variable name may have, in the editor, at playback and on a write.
 * The admission validator refuses a longer name (`maxVariableNameLength`), so a stored name is
 * longer only if it was written before that rule existed.
 */
export const MAX_VARIABLE_NAME_LENGTH = 128;

/**
 * Unicode code points one template variable value may have, in the editor, at playback and on a
 * write. The admission validator refuses a longer value (`maxVariableValueLength`), so a stored
 * value is longer only if it was written before that rule existed.
 */
export const MAX_VARIABLE_VALUE_LENGTH = 1024;

/**
 * Characters the encoded `var-*` portion of one pushed playlist URL may have.
 *
 * It keeps the request line inside the roughly 8 KB limit servers and proxies commonly enforce,
 * which the per-variable maxima above alone do not, since they multiply. Nothing stored is being
 * described here: the budget belongs to the URL this tab pushes.
 */
export const MAX_ENCODED_VARIABLES_LENGTH = 8192;

/**
 * UTF-16 code units the comma-separated values input of the editor accepts, that being the unit a
 * DOM `maxLength` counts and the only one it can count.
 *
 * Nothing stored is being described here either: it bounds the text a single control holds before
 * it is split into values, and is sized so a full in-budget list can still be typed and pasted.
 */
export const MAX_VARIABLE_VALUES_TEXT_LENGTH = 8192;

/**
 * UTF-16 code units the name input of the editor accepts, in the same unit and for the same reason
 * as the values bound above.
 *
 * It is deliberately far above `MAX_VARIABLE_NAME_LENGTH` rather than equal to it. A `maxLength`
 * equal to the limit does not tell the user anything: the browser drops the characters past it in
 * silence, and what is left is a name of exactly the limit — acceptable input, committed as though
 * it were what was typed, and never the name the user meant. Leaving the control wider than the
 * limit is what lets the code-point check refuse the name and say why, with the typed text still
 * in the field to correct.
 *
 * Sized as a bound on one control and nothing else: it is past twice the name limit, so even a
 * name written entirely in astral characters — two code units each — is refused rather than
 * clipped to exactly the limit, with room left for a pasted name to arrive whole and be reported.
 */
export const MAX_VARIABLE_NAME_TEXT_LENGTH = 1024;

/** The prefix every playlist variable parameter carries, so a pair is measured as it is written. */
const VAR_PARAM_PREFIX = 'var-';

/**
 * A name made only of characters that carry no glyph: whitespace, Unicode format characters (`Cf`,
 * which is where U+200B ZERO WIDTH SPACE, U+FEFF, the zero-width joiners, the bidi controls and
 * U+00AD SOFT HYPHEN live) and control characters (`Cc`).
 *
 * The character class is why this is a regular expression rather than a `trim()`. `String.trim()`
 * strips U+FEFF but not U+200B, and Go's `strings.TrimSpace` strips neither, so a trim-based rule
 * gave the editor, playback and the API three different answers for the same name: one stored an
 * invisible name, one played it as `var-%E2%80%8B`, and one dropped it in silence.
 *
 * `^[…]*$` over a character class has one way to match each input, so it cannot backtrack — which
 * matters, since what it is handed is stored data.
 */
const BLANK_VARIABLE_NAME = /^[\s\p{Cf}\p{Cc}]*$/u;

/**
 * Reports whether a variable name carries no character a person can see or type, in which case it
 * is no name at all: it cannot be read in the editor, reproduced in a URL, or asked about.
 *
 * This is the one definition of an empty variable name in the browser — the editor refuses such a
 * name and playback skips it — and it is mirrored by `isBlankVariableName` in
 * `apps/playlist/pkg/app/app.go`, which refuses the same set on every write path. The three
 * agreeing is the point: a name the editor rejects is a name the API rejects, and nothing invisible
 * can be stored by one layer and then interpreted differently by another.
 */
export function isBlankVariableName(name: string): boolean {
  return BLANK_VARIABLE_NAME.test(name);
}

/**
 * Reports whether `text` is at most `limit` Unicode code points long.
 *
 * The two name and value maxima are stated in code points, because that is what a character means
 * to the person typing one and to the JSON string the API stores. `String.prototype.length` counts
 * UTF-16 code units instead and charges twice for an astral character, so measuring with it would
 * refuse in the browser a name or value of half the stated length — one the API accepts and stores
 * either way, and one this tab is perfectly able to render and to put in a URL.
 *
 * The check stays bounded on untrusted input: a string's UTF-16 length is never below its
 * code-point count, so anything that fits by `length` provably fits and is never counted, and a
 * string that does not is walked only until it passes the limit — a hostile multi-megabyte value
 * costs `limit` iterations, not its own size.
 */
export function isWithinCodePointLimit(text: string, limit: number): boolean {
  if (text.length <= limit) {
    return true;
  }

  // `for...of` over a string steps one code point at a time, which is what makes this the unit
  // the limits above are stated in rather than the UTF-16 unit `length` reports.
  let codePoints = 0;
  for (const _codePoint of text) {
    codePoints++;
    if (codePoints > limit) {
      return false;
    }
  }

  return true;
}

/** The name/values pairs of one item that fit the budget, and how many the budget removed. */
export interface BoundedItemVariables {
  /** In the item's own order, with each name exactly as stored so the URL is unchanged. */
  pairs: Array<[string, string[]]>;
  /** Pairs a maximum removed. Names and values are deliberately not reported. */
  dropped: number;
  /**
   * Whether the walk stopped with own keys it never looked at, which `dropped` cannot express: a
   * key that was not inspected was not weighed against any maximum, so it is not counted as one
   * the budget removed. Set only when the map holds more own keys than a playlist item may carry.
   */
  uninspected: boolean;
}

/**
 * Reports whether a variables map holds at least one own key, and does no more work than that.
 *
 * `Object.keys(variables).length` answers the same question by allocating an array of every name a
 * stored map holds — work proportional to untrusted input for what is a yes or no. This returns at
 * the first own key. Inherited names are ignored for the same reason the walk below ignores them:
 * they are not what the item stores and are never serialized.
 */
export function hasItemVariables(variables?: Record<string, string[]>): boolean {
  if (!variables) {
    return false;
  }

  for (const name in variables) {
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the variables of one playlist item that may be applied to its URL, and how many were
 * dropped for exceeding a maximum.
 *
 * A pair that breaks a limit is dropped whole: a truncated value list would silently change which
 * series the dashboard shows, which is worse than not applying the variable at all. Playback is
 * never interrupted — an over-budget item plays with the variables that fit.
 *
 * The work this does is bounded by the budget rather than by the size of the input, in every
 * dimension a stored map has: at most one playlist item's worth of own keys is inspected at all,
 * each name and value is refused by a length comparison before anything copies or encodes it, and
 * the pairs that get as far as being measured cost at most the URL budget between them.
 */
export function boundedItemVariables(variables?: Record<string, string[]>): BoundedItemVariables {
  const pairs: Array<[string, string[]]> = [];
  let dropped = 0;

  if (!variables) {
    return { pairs, dropped, uninspected: false };
  }

  let encodedLength = 0;
  let inspected = 0;
  let uninspected = false;
  for (const name in variables) {
    // Own keys only, so the walk sees exactly what Object.entries would, in the same order,
    // without materialising an array of every name a hostile object holds.
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      continue;
    }

    // An item may apply this many variables at most, so once that many own keys have been weighed
    // there is nothing a further key can win: the walk ends here rather than reading a hostile
    // map's remaining hundred thousand names to keep a count of them. Reaching this point is what
    // proves keys were left over — the loop only gets here when the iterator produced another one.
    if (inspected >= MAX_VARIABLES_PER_ITEM) {
      uninspected = true;
      break;
    }
    inspected++;

    // The name is measured before anything is done with it: `trim()` copies the string it is
    // given, so an over-long name has to be refused by its length first or the refusal itself
    // allocates a copy of what it is refusing.
    if (!isWithinCodePointLimit(name, MAX_VARIABLE_NAME_LENGTH)) {
      dropped++;
      continue;
    }

    const values = variables[name];
    // A blank name would still be serialized — as a nameless `var-=value` parameter, or as an
    // invisible `var-%E2%80%8B=value` one for a name written in zero-width characters — and neither
    // is a variable any dashboard can resolve. Neither a blank name nor an absent value list is a
    // budget violation, so neither is reported as dropped.
    if (isBlankVariableName(name) || !Array.isArray(values) || values.length === 0) {
      continue;
    }

    if (values.length > MAX_VALUES_PER_VARIABLE) {
      dropped++;
      continue;
    }

    // The served schema promises strings, but this map arrives as JSON from a stored object, so a
    // value that is not a string is dropped rather than measured — measuring it would end playback
    // with a type error.
    if (
      values.some((value) => typeof value !== 'string' || !isWithinCodePointLimit(value, MAX_VARIABLE_VALUE_LENGTH))
    ) {
      dropped++;
      continue;
    }

    // What this pair costs in the query, measured with the serializer that writes it and in the
    // form it writes: playback hands `urlUtil.toUrlParams` a flat list of one `{ name, value }`
    // entry per value, so the string returned here is character for character the substring this
    // pair contributes to the pushed query — one `var-<name>=<value>` parameter per value, joined
    // as they appear — and the one character added pays for the `&` joining this pair to the next.
    //
    // Both halves of that are load-bearing. The serializer has to be the one measuring, because it
    // encodes in the style of AngularJS, which turns each of `! ' ( ) *` into a three-character
    // escape `encodeURIComponent` leaves alone, so an approximation of it undercounts a hostile
    // value several times over and admits a URL the budget exists to refuse. And the form has to be
    // the flat list rather than a `{ 'var-<name>': values }` map, because given a map the same
    // serializer decomposes any value whose `String()` is `[object Object]` into one indexed
    // parameter per own key — and for that string, a perfectly legal stored value, those keys are
    // its character indices, which measures roughly nine times what playback then writes and can
    // drop a pair that fits.
    const pairLength =
      urlUtil.toUrlParams(values.map((value) => ({ name: `${VAR_PARAM_PREFIX}${name}`, value }))).length + 1;

    // A pair that does not fit is skipped rather than ending the walk: a later, smaller pair still
    // fits, and dropping the largest variables first is not a decision this function should make.
    if (encodedLength + pairLength > MAX_ENCODED_VARIABLES_LENGTH) {
      dropped++;
      continue;
    }

    encodedLength += pairLength;
    pairs.push([name, values]);
  }

  return { pairs, dropped, uninspected };
}

/**
 * Reports whether a stored `variables` map is one the editor can render.
 *
 * Returns at the first violation, so an object with a hundred thousand keys costs one comparison
 * beyond it rather than a full enumeration. A value list that is not an array of strings is also
 * reported as out of budget: the editor's controls cannot represent it, and the caller's fixed
 * message is the same either way.
 *
 * The URL budget is deliberately not part of this: it belongs to what playback pushes, not to what
 * the editor can hold, and an item may legitimately be edited down to size.
 */
export function isWithinVariableBudget(variables?: Record<string, string[]>): boolean {
  if (!variables) {
    return true;
  }

  let names = 0;
  for (const name in variables) {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      continue;
    }

    names++;
    if (names > MAX_VARIABLES_PER_ITEM || !isWithinCodePointLimit(name, MAX_VARIABLE_NAME_LENGTH)) {
      return false;
    }

    const values = variables[name];
    if (!Array.isArray(values) || values.length > MAX_VALUES_PER_VARIABLE) {
      return false;
    }

    for (const value of values) {
      if (typeof value !== 'string' || !isWithinCodePointLimit(value, MAX_VARIABLE_VALUE_LENGTH)) {
        return false;
      }
    }
  }

  return true;
}
