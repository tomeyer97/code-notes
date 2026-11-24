"""Text: stop words and stems, and the near-duplicate journeys they find."""
import json, os, unittest
from jp import journey as J, folder


class WordsTest(unittest.TestCase):
    def test_one_stop_word_list_and_one_stem(self):
        self.assertFalse(hasattr(J, 'STOP'))
        self.assertEqual([J.stem(w) for w in ('placing', 'placed', 'charges', 'orders', 'is', 'runs')],
                         ['plac', 'plac', 'charg', 'order', 'is', 'runs'])

    def test_key_words_drop_stop_words_and_short_words(self):
        self.assertEqual(J.key_words('How does an order get placed?', 'Order flow'), {'order', 'get', 'plac', 'flow'})

    def test_content_words_leave_code_and_urls_out(self):
        self.assertEqual(J.content_words('The `runContext` call reads https://x.y/z twice'), ['code', 'call', 'read', 'url', 'twice'])


def journey(question, title, steps=()):
    return {'version': 2, 'question': question, 'title': title, 'nodes': [], 'edges': [],
            'steps': [{'file': f, 'range': {'start': a, 'end': b}} for f, a, b in steps]}


class NearDuplicatesTest(unittest.TestCase):
    def similar(self, mine, theirs):
        d = folder(self, {'journeys/theirs.json': json.dumps(theirs)}, git=False)
        return J.similar_journeys(J.Journeys(d), 'mine', mine)

    def test_the_same_question_in_other_words(self):
        got = self.similar(journey('How does an order get placed and paid?', 'Order and payment'),
                           journey('How is an order placed and paid?', 'Placing orders'))
        self.assertEqual(len(got), 1)
        self.assertIn('question and title are very similar to journey theirs', got[0])

    def test_a_neighbouring_question_is_not_a_duplicate(self):
        self.assertEqual(self.similar(journey('How is an order paid?', 'Payment'),
                                      journey('How does the shop charge an order?', 'Charging')), [])

    def test_the_same_title(self):
        got = self.similar(journey('How do refunds work?', 'Orders'), journey('Where are orders kept?', 'orders'))
        self.assertIn('is also the title of journey theirs', got[0])

    def test_most_steps_on_the_same_code(self):
        code = [('a.js', 10, 12), ('a.js', 20, 22), ('b.js', 5, 6)]
        theirs = journey('Where does the cart live?', 'Cart', [('a.js', 1, 30), ('b.js', 1, 9)])
        got = self.similar(journey('How is stock counted?', 'Stock', code), theirs)
        self.assertEqual(got, ['3 of 3 steps are anchored on the same code as journey theirs ("Where does the cart live?"): '
                               'it tells the same story; extend that journey instead'])
        two = journey('How is stock counted?', 'Stock', code[:2])      # fewer than SAME_CODE_MIN steps: a neighbour
        self.assertEqual(self.similar(two, theirs), [])


if __name__ == '__main__':
    unittest.main()
