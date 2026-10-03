#!/usr/bin/env python3
"""A stand-in for a tell-lint script in tests: same --stdin interface and output format.

Fails: stock connectors, em dashes. Warnings: filler words, hedges.
Exit 1 when any fail is found, 0 otherwise.
"""
import re
import sys

FAILS = [("stock-connector", r"\b(Moreover|Furthermore)\b"), ("emdash", "—")]
WARNS = [("filler-robust", r"\brobust\b"), ("hedge-generally", r"\bgenerally speaking\b")]


def scan(lines, rules):
    return [(rule, n, ln.strip()[:96]) for n, ln in enumerate(lines, 1) for rule, pat in rules if re.search(pat, ln)]


def main():
    lines = sys.stdin.read().split("\n")
    fails, warns = scan(lines, FAILS), scan(lines, WARNS)
    if fails:
        print("tell-lint: rewrite before delivering.")
        for rule, n, ex in fails:
            print(f"  [{rule}] line {n}: {ex}")
    if warns:
        print("warnings (not blocking):")
        for rule, n, ex in warns:
            print(f"  [{rule}] line {n}: {ex}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
