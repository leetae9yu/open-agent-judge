import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_reverses_ascii_text(self):
        self.assertEqual(candidate("agentoj"), "jotnega")

    def test_reverses_unicode_text(self):
        self.assertEqual(candidate("가나다"), "다나가")

    def test_empty_string(self):
        self.assertEqual(candidate(""), "")


if __name__ == "__main__":
    unittest.main()
