package bridge

import (
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSnowflakeLayout(t *testing.T) {
	s := snowflake{worker: 0x2a5}
	now := idEpoch + int64(time.Hour/time.Millisecond)
	first, second := s.next(now), s.next(now)
	if first>>22 != uint64(now-idEpoch) || first>>12&0x3ff != 0x2a5 || first&0xfff != 0 {
		t.Fatalf("first ID %b does not hold the time, worker and sequence", first)
	}
	if second != first+1 {
		t.Fatalf("the second ID of a millisecond is %d, want %d", second, first+1)
	}
	if third := s.next(now + 1); third>>22 != uint64(now+1-idEpoch) || third&0xfff != 0 {
		t.Fatalf("a new millisecond starts sequence 0, got %b", third)
	}
}

func TestSnowflakeIncreasesWhenTheClockStalls(t *testing.T) {
	s := snowflake{}
	now := int64(idEpoch + 1000)
	previous := s.next(now)
	// 4096 IDs exhaust a millisecond; the clock then goes back by a second.
	for i := range 5000 {
		clock := now
		if i > 4096 {
			clock = now - 1000
		}
		id := s.next(clock)
		if id <= previous {
			t.Fatalf("ID %d after %d at step %d", id, previous, i)
		}
		previous = id
	}
	if previous>>22 != uint64(now+1-idEpoch) {
		t.Fatalf("IDs past the sequence limit borrow the next millisecond, got %d", previous>>22)
	}
}

func TestNewIDIsUniqueAcrossGoroutines(t *testing.T) {
	const workers, each = 8, 2000
	seen := make(chan string, workers*each)
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for range each {
				seen <- NewID()
			}
		})
	}
	wg.Wait()
	close(seen)
	unique := make(map[string]bool, workers*each)
	for id := range seen {
		if _, err := strconv.ParseUint(id, 36, 63); err != nil || strings.ToLower(id) != id {
			t.Fatalf("ID %q is not a 63-bit number in lowercase base 36: %v", id, err)
		}
		if unique[id] {
			t.Fatalf("ID %s was returned twice", id)
		}
		unique[id] = true
	}
}
