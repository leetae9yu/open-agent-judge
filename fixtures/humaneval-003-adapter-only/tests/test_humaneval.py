import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_reverses_ascii(self):
        self.assertEqual(candidate("agent"), "tnega")

    def test_reverses_empty_string(self):
        self.assertEqual(candidate(""), "")


if __name__ == "__main__":
    unittest.main()
