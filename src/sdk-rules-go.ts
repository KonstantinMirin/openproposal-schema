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
	Violations []struct {
		When    any    \`json:"when"\`
		Path    string \`json:"path"\`
		Message any    \`json:"message"\`
	} \`json:"violations"\`
}

type programSet struct {
	Defs  map[string]any         \`json:"defs"\`
	Rules map[string]ruleProgram \`json:"rules"\`
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
			l, ok := ev(args[0]).([]any)
			y := ev(args[1])
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
		case "filter", "sum", "find":
			l, ok := ev(args[0]).([]any)
			if !ok {
				if op == "sum" {
					return intRat(0)
				}
				return nil
			}
			name := args[1].(string)
			switch op {
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

// checkRules adds to errs each violation of the rules on v, a value of their owner at at.
func checkRules(v any, at string, errs *Errors, rules ...string) {
	loadRules()
	e := &evaluation{root: fromJSON(v), memo: map[string]any{}}
	for _, id := range rules {
		for _, w := range programs.Rules[id].Violations {
			if e.eval(w.When, map[string]any{}) != true {
				continue
			}
			msg, ok := e.eval(w.Message, map[string]any{}).(string)
			if !ok {
				msg = "violates the rule"
			}
			errs.add(at+w.Path, "%s", msg)
		}
	}
}
`;
