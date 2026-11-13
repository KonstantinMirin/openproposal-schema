/**
 * The Go SDK's rule programs: the evaluator of src/rule-program.ts, ported
 * to Go with the same semantics, which `rules.go` holds; the programs and the
 * time zone table follow it as JSON the package parses once.
 */

/** The evaluator, as Go source after the package clause; `programsJSON` and `zonesJSON` are declared beside it. */
export const GO_EVALUATOR = `import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type ruleProgram struct {
	Owner      string     \`json:"owner"\`
	On         string     \`json:"on"\`
	At         [][]string \`json:"at"\`
	Undecided  any        \`json:"undecided"\`
	Violations []struct {
		Each    any      \`json:"each"\`
		As      []string \`json:"as"\`
		When    any      \`json:"when"\`
		Path    any      \`json:"path"\`
		Message any      \`json:"message"\`
	} \`json:"violations"\`
}

type programSet struct {
	Defs  map[string]any         \`json:"defs"\`
	Rules map[string]ruleProgram \`json:"rules"\`
	Lists map[string][]any       \`json:"lists"\`
}

type zoneTable struct {
	Release string            \`json:"release"\`
	From    int64             \`json:"from"\`
	Until   int64             \`json:"until"\`
	Zones   map[string]string \`json:"zones"\`
	Names   map[string]string \`json:"names"\`
}

var (
	rulesOnce sync.Once
	programs  programSet
	zones     zoneTable
	decodedMu sync.Mutex
	decoded   = map[string][2][]int64{}
)

func loadRules() {
	rulesOnce.Do(func() {
		dec := json.NewDecoder(strings.NewReader(programsJSON))
		dec.UseNumber()
		if err := dec.Decode(&programs); err != nil {
			panic(err)
		}
		if err := json.Unmarshal([]byte(zonesJSON), &zones); err != nil {
			panic(err)
		}
	})
}

// fromJSON reads a JSON value as a program does: each number an exact rational.
func fromJSON(v any) any {
	switch x := v.(type) {
	case json.Number:
		r, ok := new(big.Rat).SetString(string(x))
		if !ok {
			return nil
		}
		return r
	case []any:
		out := make([]any, len(x))
		for i, y := range x {
			out[i] = fromJSON(y)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, y := range x {
			out[k] = fromJSON(y)
		}
		return out
	case string, bool, nil:
		return x
	}
	return nil
}

func same(a, b any) bool {
	switch x := a.(type) {
	case *big.Rat:
		y, ok := b.(*big.Rat)
		return ok && x.Cmp(y) == 0
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !same(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !same(v, w) {
				return false
			}
		}
		return true
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

func ratText(x *big.Rat) string {
	d := new(big.Int).Set(x.Denom())
	twos, fives := 0, 0
	two, five, zero := big.NewInt(2), big.NewInt(5), big.NewInt(0)
	m := new(big.Int)
	for m.Mod(d, two).Cmp(zero) == 0 {
		d.Quo(d, two)
		twos++
	}
	for m.Mod(d, five).Cmp(zero) == 0 {
		d.Quo(d, five)
		fives++
	}
	if d.Cmp(big.NewInt(1)) != 0 {
		return x.Num().String() + "/" + x.Denom().String()
	}
	k := twos
	if fives > k {
		k = fives
	}
	scaled := new(big.Int).Abs(x.Num())
	scaled.Mul(scaled, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(k)), nil))
	scaled.Quo(scaled, x.Denom())
	digits := scaled.String()
	for len(digits) < k+1 {
		digits = "0" + digits
	}
	text := digits
	if k > 0 {
		text = digits[:len(digits)-k] + "." + digits[len(digits)-k:]
	}
	if x.Sign() < 0 {
		return "-" + text
	}
	return text
}

func daysFromCivil(y, m, d int64) int64 {
	if m <= 2 {
		y--
	}
	era := y / 400
	if y < 0 && y%400 != 0 {
		era--
	}
	yoe := y - era*400
	mm := m + 9
	if m > 2 {
		mm = m - 3
	}
	doy := (153*mm+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

func localDay(seconds int64, zone string) (int64, bool) {
	if seconds < zones.From || seconds >= zones.Until {
		return 0, false
	}
	key, ok := zones.Names[zone]
	if !ok {
		return 0, false
	}
	decodedMu.Lock()
	z, ok := decoded[key]
	if !ok {
		parts := strings.SplitN(zones.Zones[key], "|", 2)
		var values []int64
		for _, o := range strings.Split(parts[0], ",") {
			n, _ := strconv.ParseInt(o, 36, 64)
			values = append(values, n)
		}
		t := zones.From
		var at, off []int64
		for _, c := range strings.Split(parts[1], " ") {
			p := strings.SplitN(c, ".", 2)
			delta, _ := strconv.ParseInt(p[0], 36, 64)
			index, _ := strconv.ParseInt(p[1], 36, 64)
			t += delta
			at = append(at, t)
			off = append(off, values[index])
		}
		z = [2][]int64{at, off}
		decoded[key] = z
	}
	decodedMu.Unlock()
	at, off := z[0], z[1]
	i := sort.Search(len(at), func(i int) bool { return at[i] > seconds }) - 1
	if i < 0 {
		i = 0
	}
	v := seconds + off[i]
	day := v / 86400
	if v < 0 && v%86400 != 0 {
		day--
	}
	return day, true
}

var instantPattern = regexp.MustCompile(\`^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})Z$\`)

var momentPattern = regexp.MustCompile(\`^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?(?:([Zz])|([+-])([0-9]{2}):([0-9]{2}))$\`)
var durationPattern = regexp.MustCompile(\`^P(?:([0-9]+)Y)?(?:([0-9]+)M)?(?:([0-9]+)W)?(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$\`)
var decimalPattern = regexp.MustCompile(\`^-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$\`)

var (
	patternsMu sync.Mutex
	patterns   = map[string]*regexp.Regexp{}
)

// compiledPattern is a program's pattern, matched against the whole text.
func compiledPattern(p string) *regexp.Regexp {
	patternsMu.Lock()
	defer patternsMu.Unlock()
	re, ok := patterns[p]
	if !ok {
		re = regexp.MustCompile(\`^(?:\` + p + \`)$\`)
		patterns[p] = re
	}
	return re
}

// jsonText is a value's JSON text: a map's keys sorted, a number in its shortest decimal form.
func jsonText(v any) string {
	switch x := v.(type) {
	case *big.Rat:
		return ratText(x)
	case []any:
		parts := make([]string, len(x))
		for i, y := range x {
			parts[i] = jsonText(y)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = jsonString(k) + ":" + jsonText(x[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	case string:
		return jsonString(x)
	case bool:
		return strconv.FormatBool(x)
	}
	return "null"
}

func jsonString(s string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\\n")
}

func ruleRat(v any) *big.Rat {
	r, _ := v.(*big.Rat)
	return r
}

func intRat(n int64) *big.Rat { return new(big.Rat).SetInt64(n) }

func arith(args []any, f func(a, b *big.Rat) *big.Rat) any {
	if len(args) == 0 {
		return nil
	}
	acc := ruleRat(args[0])
	for _, x := range args[1:] {
		b := ruleRat(x)
		if acc == nil || b == nil {
			return nil
		}
		acc = f(acc, b)
		if acc == nil {
			return nil
		}
	}
	if acc == nil {
		return nil
	}
	return acc
}

type evaluation struct {
	root any
	up   any
	memo map[string]any
}

func (e *evaluation) eval(x any, vars map[string]any) any {
	switch v := x.(type) {
	case nil, bool, string:
		return v
	case json.Number:
		return fromJSON(v)
	case map[string]any:
		return fromJSON(v)
	case []any:
		op, _ := v[0].(string)
		args := v[1:]
		ev := func(a any) any { return e.eval(a, vars) }
		with := func(a any, name string, val any) any {
			more := make(map[string]any, len(vars)+1)
			for k, w := range vars {
				more[k] = w
			}
			more[name] = val
			return e.eval(a, more)
		}
		switch op {
		case "$":
			return e.root
		case "up":
			return e.up
		case "given":
			// An SDK's holder is whole: it shows every member.
			return true
		case "part":
			// An SDK reads whole payloads, never a part of a document a code block shows.
			return false
		case "places":
			key, _ := ev(args[1]).(string)
			out := []any{}
			var walk func(x any, at string)
			walk = func(x any, at string) {
				switch y := x.(type) {
				case []any:
					for i, z := range y {
						walk(z, at+"/"+strconv.Itoa(i))
					}
				case map[string]any:
					keys := make([]string, 0, len(y))
					for k := range y {
						keys = append(keys, k)
					}
					sort.Strings(keys)
					for _, k := range keys {
						here := at + "/" + pointerToken(k)
						if k == key {
							out = append(out, here)
						} else {
							walk(y[k], here)
						}
					}
				}
			}
			walk(ev(args[0]), "")
			return out
		case "def":
			name := args[0].(string)
			if r, ok := e.memo[name]; ok {
				return r
			}
			r := e.eval(programs.Defs[name], map[string]any{})
			e.memo[name] = r
			return r
		case "var":
			return vars[args[0].(string)]
		case "get":
			if m, ok := ev(args[0]).(map[string]any); ok {
				return m[args[1].(string)]
			}
			return nil
		case "at":
			l, ok := ev(args[0]).([]any)
			i := ruleRat(ev(args[1]))
			if !ok || i == nil || !i.IsInt() || i.Sign() < 0 || i.Num().Int64() >= int64(len(l)) {
				return nil
			}
			return l[i.Num().Int64()]
		case "list":
			out := make([]any, len(args))
			for i, a := range args {
				out[i] = ev(a)
			}
			return out
		case "table":
			k, ok := ev(args[0]).(string)
			t, _ := args[1].(map[string]any)
			if w, found := t[k]; ok && found {
				return fromJSON(w)
			}
			return nil
		case "has":
			m, ok := ev(args[0]).(map[string]any)
			if !ok {
				return false
			}
			_, found := m[args[1].(string)]
			return found
		case "ismap":
			_, ok := ev(args[0]).(map[string]any)
			return ok
		case "islist":
			_, ok := ev(args[0]).([]any)
			return ok
		case "isnum":
			return ruleRat(ev(args[0])) != nil
		case "isstr":
			_, ok := ev(args[0]).(string)
			return ok
		case "eq":
			return same(ev(args[0]), ev(args[1]))
		case "ne":
			return !same(ev(args[0]), ev(args[1]))
		case "lt", "le", "gt", "ge":
			a, b := ruleRat(ev(args[0])), ruleRat(ev(args[1]))
			if a == nil || b == nil {
				return false
			}
			c := a.Cmp(b)
			switch op {
			case "lt":
				return c < 0
			case "le":
				return c <= 0
			case "gt":
				return c > 0
			}
			return c >= 0
		case "and":
			for _, a := range args {
				if ev(a) != true {
					return false
				}
			}
			return true
		case "or":
			for _, a := range args {
				if ev(a) == true {
					return true
				}
			}
			return false
		case "not":
			return ev(args[0]) != true
		case "if":
			if ev(args[0]) == true {
				return ev(args[1])
			}
			return ev(args[2])
		case "coalesce":
			for _, a := range args {
				if w := ev(a); w != nil {
					return w
				}
			}
			return nil
		case "add", "sub", "mul", "div":
			vals := make([]any, len(args))
			for i, a := range args {
				vals[i] = ev(a)
			}
			return arith(vals, func(a, b *big.Rat) *big.Rat {
				switch op {
				case "add":
					return new(big.Rat).Add(a, b)
				case "sub":
					return new(big.Rat).Sub(a, b)
				case "mul":
					return new(big.Rat).Mul(a, b)
				}
				if b.Sign() == 0 {
					return nil
				}
				return new(big.Rat).Quo(a, b)
			})
		case "floor":
			r := ruleRat(ev(args[0]))
			if r == nil {
				return nil
			}
			q := new(big.Int)
			m := new(big.Int)
			q.DivMod(r.Num(), r.Denom(), m)
			return new(big.Rat).SetInt(q)
		case "len":
			if l, ok := ev(args[0]).([]any); ok {
				return intRat(int64(len(l)))
			}
			return nil
		case "contains":
			c := ev(args[0])
			y := ev(args[1])
			if s, ok := c.(string); ok {
				t, ok := y.(string)
				return ok && strings.Contains(s, t)
			}
			l, ok := c.([]any)
			if !ok {
				return false
			}
			for _, z := range l {
				if same(z, y) {
					return true
				}
			}
			return false
		case "concat":
			var out []any
			for _, a := range args {
				l, ok := ev(a).([]any)
				if !ok {
					return nil
				}
				out = append(out, l...)
			}
			if out == nil {
				out = []any{}
			}
			return out
		case "values":
			m, ok := ev(args[0]).(map[string]any)
			if !ok {
				return nil
			}
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out := make([]any, len(keys))
			for i, k := range keys {
				out[i] = m[k]
			}
			return out
		case "keys":
			m, ok := ev(args[0]).(map[string]any)
			if !ok {
				return nil
			}
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out := make([]any, len(keys))
			for i, k := range keys {
				out[i] = k
			}
			return out
		case "filter", "map", "sum", "find":
			l, ok := ev(args[0]).([]any)
			if !ok {
				if op == "sum" {
					return intRat(0)
				}
				return nil
			}
			name := args[1].(string)
			switch op {
			case "map":
				out := make([]any, len(l))
				for i, y := range l {
					out[i] = with(args[2], name, y)
				}
				return out
			case "filter":
				out := []any{}
				for _, y := range l {
					if with(args[2], name, y) == true {
						out = append(out, y)
					}
				}
				return out
			case "find":
				for _, y := range l {
					if with(args[2], name, y) == true {
						return y
					}
				}
				return nil
			}
			vals := []any{intRat(0)}
			for _, y := range l {
				vals = append(vals, with(args[2], name, y))
			}
			return arith(vals, func(a, b *big.Rat) *big.Rat { return new(big.Rat).Add(a, b) })
		case "instant":
			s, ok := ev(args[0]).(string)
			m := instantPattern.FindStringSubmatch(s)
			if !ok || m == nil {
				return nil
			}
			n := make([]int64, 6)
			for i := range n {
				n[i], _ = strconv.ParseInt(m[i+1], 10, 64)
			}
			return intRat(daysFromCivil(n[0], n[1], n[2])*86400 + n[3]*3600 + n[4]*60 + n[5])
		case "moment":
			s, ok := ev(args[0]).(string)
			m := momentPattern.FindStringSubmatch(s)
			if !ok || m == nil {
				return nil
			}
			n := make([]int64, 6)
			for i := range n {
				n[i], _ = strconv.ParseInt(m[i+1], 10, 64)
			}
			var offset int64
			if m[8] == "" {
				h, _ := strconv.ParseInt(m[10], 10, 64)
				mi, _ := strconv.ParseInt(m[11], 10, 64)
				offset = (h*60 + mi) * 60
				if m[9] == "-" {
					offset = -offset
				}
			}
			r := intRat(daysFromCivil(n[0], n[1], n[2])*86400 + n[3]*3600 + n[4]*60 + n[5] - offset)
			if m[7] != "" {
				f, _ := new(big.Rat).SetString("0" + m[7])
				r.Add(r, f)
			}
			return r
		case "duration":
			s, ok := ev(args[0]).(string)
			m := durationPattern.FindStringSubmatch(s)
			if !ok || m == nil || s == "P" || strings.HasSuffix(s, "T") {
				return nil
			}
			n := make([]*big.Int, 8)
			for i := 1; i <= 7; i++ {
				n[i] = new(big.Int)
				if m[i] != "" {
					n[i].SetString(m[i], 10)
				}
			}
			months := new(big.Int).Add(new(big.Int).Mul(n[1], big.NewInt(12)), n[2])
			days := new(big.Int).Add(new(big.Int).Mul(n[3], big.NewInt(7)), n[4])
			hours := new(big.Int).Add(new(big.Int).Mul(days, big.NewInt(24)), n[5])
			secs := new(big.Int).Add(new(big.Int).Add(new(big.Int).Mul(hours, big.NewInt(3600)), new(big.Int).Mul(n[6], big.NewInt(60))), n[7])
			return []any{new(big.Rat).SetInt(months), new(big.Rat).SetInt(secs)}
		case "matches":
			s, ok := ev(args[0]).(string)
			p, ok2 := ev(args[1]).(string)
			if !ok || !ok2 {
				return false
			}
			return compiledPattern(p).MatchString(s)
		case "split":
			s, ok := ev(args[0]).(string)
			sep, ok2 := ev(args[1]).(string)
			if !ok || !ok2 || sep == "" {
				return nil
			}
			parts := strings.Split(s, sep)
			out := make([]any, len(parts))
			for i, x := range parts {
				out[i] = x
			}
			return out
		case "num":
			s, ok := ev(args[0]).(string)
			if !ok || !decimalPattern.MatchString(s) {
				return nil
			}
			r, ok := new(big.Rat).SetString(s)
			if !ok {
				return nil
			}
			return r
		case "pointer":
			var b strings.Builder
			for _, a := range args {
				var t string
				switch w := ev(a).(type) {
				case *big.Rat:
					t = ratText(w)
				case string:
					t = w
				case nil:
					t = "null"
				case bool:
					t = strconv.FormatBool(w)
				default:
					t = jsonText(w)
				}
				b.WriteString("/" + pointerToken(t))
			}
			return b.String()
		case "json":
			return jsonText(ev(args[0]))
		case "listed":
			name, _ := args[0].(string)
			codes, found := programs.Lists[name]
			x := ev(args[1])
			if !found {
				return nil
			}
			for _, c := range codes {
				switch cv := c.(type) {
				case string:
					if s, ok := x.(string); ok && s == cv {
						return true
					}
				case json.Number:
					r, ok := x.(*big.Rat)
					want, ok2 := new(big.Rat).SetString(string(cv))
					if ok && ok2 && r.Cmp(want) == 0 {
						return true
					}
				}
			}
			return false
		case "local_day":
			t := ruleRat(ev(args[0]))
			z, ok := ev(args[1]).(string)
			if t == nil || !t.IsInt() || !ok {
				return nil
			}
			day, found := localDay(t.Num().Int64(), z)
			if !found {
				return nil
			}
			return intRat(day)
		case "str":
			var b strings.Builder
			for _, a := range args {
				switch w := ev(a).(type) {
				case *big.Rat:
					b.WriteString(ratText(w))
				case nil:
					b.WriteString("null")
				case string:
					b.WriteString(w)
				default:
					j, _ := json.Marshal(w)
					b.Write(j)
				}
			}
			return b.String()
		}
		panic(fmt.Sprintf("no operation %q", op))
	}
	return nil
}

type ruleViolation struct {
	path    string
	message string
}

// check gives the violations of one rule on a value of its owner, below it, with its holder's whole value; none where the rule can't decide.
func check(id string, v any, holder any) []ruleViolation {
	p := programs.Rules[id]
	root := fromJSON(v)
	e := &evaluation{root: root, up: root, memo: map[string]any{}}
	if holder != nil {
		e.up = fromJSON(holder)
	}
	if p.Undecided != nil && e.eval(p.Undecided, map[string]any{}) == true {
		return nil
	}
	var out []ruleViolation
	for _, w := range p.Violations {
		for _, names := range e.bindings(w.Each, w.As) {
			if e.eval(w.When, names) != true {
				continue
			}
			msg, ok := e.eval(w.Message, names).(string)
			if !ok {
				msg = "violates the rule"
			}
			path, _ := e.eval(w.Path, names).(string)
			out = append(out, ruleViolation{path, msg})
		}
	}
	return out
}

// bindings gives the names a violation binds, once per item of its each; once, binding none, without one.
func (e *evaluation) bindings(each any, as []string) []map[string]any {
	if each == nil || len(as) != 2 {
		return []map[string]any{{}}
	}
	var out []map[string]any
	switch x := e.eval(each, map[string]any{}).(type) {
	case []any:
		for i, y := range x {
			out = append(out, map[string]any{as[0]: intRat(int64(i)), as[1]: y})
		}
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, map[string]any{as[0]: k, as[1]: x[k]})
		}
	}
	return out
}

func pointerToken(k string) string {
	return strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1")
}

// ruleViolations gives the violations of one rule on a value of the type that runs it, its owner or the owner's holder, each at a JSON pointer below the value.
func ruleViolations(id string, v any) []ruleViolation {
	p := programs.Rules[id]
	if p.On == "" || p.On == p.Owner {
		return check(id, v, nil)
	}
	type placed struct {
		at string
		v  any
	}
	var out []ruleViolation
	for _, place := range p.At {
		here := []placed{{"", v}}
		for _, seg := range place {
			var next []placed
			for _, h := range here {
				switch x := h.v.(type) {
				case []any:
					if seg == "*" {
						for i, y := range x {
							next = append(next, placed{h.at + "/" + strconv.Itoa(i), y})
						}
					}
				case map[string]any:
					if seg == "*" {
						keys := make([]string, 0, len(x))
						for k := range x {
							keys = append(keys, k)
						}
						sort.Strings(keys)
						for _, k := range keys {
							next = append(next, placed{h.at + "/" + pointerToken(k), x[k]})
						}
					} else if y, ok := x[seg]; ok {
						next = append(next, placed{h.at + "/" + pointerToken(seg), y})
					}
				}
			}
			here = next
		}
		for _, h := range here {
			for _, w := range check(id, h.v, v) {
				out = append(out, ruleViolation{h.at + w.path, w.message})
			}
		}
	}
	return out
}

// checkRules adds to errs each violation of the rules on v, a value of the type that runs them at at.
func checkRules(v any, at string, errs *Errors, rules ...string) {
	loadRules()
	for _, id := range rules {
		for _, w := range ruleViolations(id, v) {
			errs.add(at+w.path, "%s", w.message)
		}
	}
}
`;
