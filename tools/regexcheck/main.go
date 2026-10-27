// Command regexcheck reports how Go's regexp package (RE2) matches each kernel
// pattern against each value. The kernel gate compares the verdicts with
// ECMA-262 and Python. It reads {"cases":[{"pattern","value"}]} on stdin and
// writes {"go","verdicts":[bool]} on stdout. A pattern that doesn't compile
// exits with status 1.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"runtime"
)

type input struct {
	Cases []struct {
		Pattern string `json:"pattern"`
		Value   string `json:"value"`
	} `json:"cases"`
}

type output struct {
	Go       string `json:"go"`
	Verdicts []bool `json:"verdicts"`
}

func main() {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fmt.Fprintf(os.Stderr, "regexcheck: reading input: %v\n", err)
		os.Exit(1)
	}
	compiled := map[string]*regexp.Regexp{}
	out := output{Go: runtime.Version(), Verdicts: make([]bool, 0, len(in.Cases))}
	for _, c := range in.Cases {
		re, ok := compiled[c.Pattern]
		if !ok {
			var err error
			re, err = regexp.Compile(c.Pattern)
			if err != nil {
				fmt.Fprintf(os.Stderr, "regexcheck: RE2 doesn't compile %q: %v\n", c.Pattern, err)
				os.Exit(1)
			}
			compiled[c.Pattern] = re
		}
		out.Verdicts = append(out.Verdicts, re.MatchString(c.Value))
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "regexcheck: writing output: %v\n", err)
		os.Exit(1)
	}
}
