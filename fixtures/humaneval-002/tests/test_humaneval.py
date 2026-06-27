import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_returns_largest_positive(self):
        self.assertEqual(candidate([1, 7, 3]), 7)

    def test_returns_largest_negative(self):
        self.assertEqual(candidate([-9, -2, -5]), -2)


if __name__ == "__main__":
    unittest.main()
