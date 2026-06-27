import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_counts_lowercase_vowels(self):
        self.assertEqual(candidate("leetcode for ai"), 7)

    def test_counts_uppercase_vowels(self):
        self.assertEqual(candidate("AEIOU xyz"), 5)

    def test_counts_no_vowels(self):
        self.assertEqual(candidate("rhythms"), 0)


if __name__ == "__main__":
    unittest.main()
