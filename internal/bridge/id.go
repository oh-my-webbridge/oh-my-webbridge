package bridge

import (
	"math/rand/v2"
	"strconv"
	"sync"
	"time"
)

// idEpoch is 2026-01-01T00:00:00Z in Unix milliseconds.
const idEpoch = 1767225600000

// snowflake hands out 64-bit Snowflake IDs: 41 bits of milliseconds since
// idEpoch, a 10-bit worker and a 12-bit sequence, the layout that the
// extension uses in extension/src/id.ts. The IDs of one generator increase
// strictly: when the clock goes back or a millisecond runs out of sequence
// numbers, the generator continues on its last millisecond and moves to the
// next one.
type snowflake struct {
	mu       sync.Mutex
	worker   uint64
	last     int64
	sequence uint64
}

func (s *snowflake) next(now int64) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if now > s.last {
		s.last, s.sequence = now, 0
	} else if s.sequence++; s.sequence > 0xfff {
		s.last, s.sequence = s.last+1, 0
	}
	return uint64(s.last-idEpoch)<<22 | s.worker<<12 | s.sequence
}

// The daemon draws its worker at random, so a daemon that restarts within the
// same millisecond, or after the clock went back, rarely repeats an ID.
var ids = snowflake{worker: rand.Uint64N(1 << 10)}

// NewID returns a new Snowflake ID in lowercase base 36, which costs fewer
// tokens than decimal or hex across the tokenizers that benchmarks/ids
// measures.
func NewID() string {
	return strconv.FormatUint(ids.next(time.Now().UnixMilli()), 36)
}
