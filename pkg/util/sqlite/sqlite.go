package sqlite

import (
	"context"
	"errors"
	"time"
)

// MinBusyWait is the shortest time a statement must have spent inside the
// driver before its interruption can be attributed to the busy handler.
//
// SQLite has no server and no network: the only thing that makes a statement
// sleep is the busy handler installed by the busy_timeout pragma this package
// configures on every connection (see convertSQLite3URL), waiting for another
// connection to release the database write lock. An uncontended statement of
// the shape this driver serves — single-row DML and indexed lookups against a
// local file — completes in microseconds, so a whole second inside the driver
// is orders of magnitude beyond it, while a statement that is waiting for the
// lock spends very nearly the whole busy timeout there (7.5s by default,
// because SQLite only checks for an interrupt between steps and therefore does
// not abandon the wait when the context expires). The gap between those two is
// what makes the attribution safe in both directions.
const MinBusyWait = time.Second

// IsInterruptedBusyWait reports whether err is the same busy condition
// IsBusyOrLocked recognises, in the form it takes when the statement's context
// expired before the busy handler gave up. waited is how long the statement
// itself spent inside the driver.
//
// The driver interrupts a statement whose context is done and then returns the
// context error in place of the SQLite result code (modernc.org/sqlite's
// stmt.exec and stmt.query overwrite the error whenever their interrupt fired),
// so SQLITE_BUSY is destroyed on its way out whenever the caller's deadline is
// shorter than the remaining busy wait. Every caller that classifies the busy
// condition from the driver error alone therefore misses the contention that
// happens to be interrupted, which is all of it whenever a deadline is shorter
// than the busy timeout. Recognising the condition needs the one fact the
// driver error no longer carries — how long the statement waited — which only
// the code that ran the statement holds, so it is passed in.
//
// A cancelled context is never the busy condition: that is a caller that hung
// up, and its statement is interrupted for a reason that has nothing to do with
// the database write lock. It is rejected explicitly rather than left to
// errors.Is, so that an error joining both context sentinels cannot be reported
// as contention.
func IsInterruptedBusyWait(err error, waited time.Duration) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return waited >= MinBusyWait
}
