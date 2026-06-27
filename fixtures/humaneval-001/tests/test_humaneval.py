import unittest

from solution import candidate


class CandidateTest(unittest.TestCase):
    def test_returns_first_element(self):
        self.assertEqual(candidate([3, 2, 1]), 3)

    def test_keeps_object_identity(self):
        marker = object()
        self.assertIs(candidate([marker, object()]), marker)


if __name__ == "__main__":
    unittest.main()
