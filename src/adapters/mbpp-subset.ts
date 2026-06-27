import type { Problem } from "../contracts/types.ts";

export const MBPP_UPSTREAM_COMMIT = "e3937aa2643402c194316d74917acee1dc4e8993";
export const MBPP_UPSTREAM_DATA_URL = "https://raw.githubusercontent.com/google-research/google-research/e3937aa2643402c194316d74917acee1dc4e8993/mbpp/sanitized-mbpp.json";
export const MBPP_UPSTREAM_DATA_SHA256 = "sha256:ca95deaa9a01ef0a6f439f88bcf0dd3db3563d22f22aad6cae04ebb9a8d8c8e9";
export const MBPP_SUBSET_DESCRIPTOR_REVISION = "mbpp-subset-50-v1";

export interface MbppSubsetManifestEntry {
  problemId: string;
  upstreamTaskId: string;
  taskId: number;
  entryPoint: string;
  title: string;
  oracleDescriptorHash: string;
}

export interface MbppSelectionExclusion {
  taskId: number;
  reason: string;
}

export const MBPP_SUBSET_SELECTION_EXCLUSIONS = [{"taskId": 2, "reason": "assert left is not a direct selected function call"}, {"taskId": 6, "reason": "assert left is not a direct selected function call"}, {"taskId": 7, "reason": "assert left is not a direct selected function call"}, {"taskId": 18, "reason": "assert left is not a direct selected function call"}, {"taskId": 56, "reason": "assert left is not a direct selected function call"}, {"taskId": 70, "reason": "assert left is not a direct selected function call"}, {"taskId": 82, "reason": "requires imports"}, {"taskId": 85, "reason": "requires imports"}, {"taskId": 98, "reason": "requires imports"}] as const satisfies readonly MbppSelectionExclusion[];

export const MBPP_SUBSET_ORACLE_MANIFEST = [
  {"problemId": "mbpp-full-003", "upstreamTaskId": "MBPP/3", "taskId": 3, "entryPoint": "is_not_prime", "title": "MBPP 003 — Write a python function to identify non-prime numbers", "oracleDescriptorHash": "sha256:cfd795b3714c2171b77d98002d9e6fc42026ce9f0afd853b95c87e24782322d4"},
  {"problemId": "mbpp-full-004", "upstreamTaskId": "MBPP/4", "taskId": 4, "entryPoint": "heap_queue_largest", "title": "MBPP 004 — Write a function to find the n largest integers from a given list of numbers, returned in descending order", "oracleDescriptorHash": "sha256:0d384ba09436d873b08738b00ae2d3e01778b9f3a53ffd1f0472d8339250fdda"},
  {"problemId": "mbpp-full-008", "upstreamTaskId": "MBPP/8", "taskId": 8, "entryPoint": "square_nums", "title": "MBPP 008 — Write a function to find squares of individual elements in a list", "oracleDescriptorHash": "sha256:78c7583bb5986eec456de2404c98ffd7444abc1a26224727e44dc901de8aa7ee"},
  {"problemId": "mbpp-full-009", "upstreamTaskId": "MBPP/9", "taskId": 9, "entryPoint": "find_Rotations", "title": "MBPP 009 — Write a python function to find the minimum number of rotations (greater than 0) required to get the same string", "oracleDescriptorHash": "sha256:1d0dcdd3b0fe105371223ad525a31e8e86dc880df3fd27c8f493d3b3e2d16d15"},
  {"problemId": "mbpp-full-011", "upstreamTaskId": "MBPP/11", "taskId": 11, "entryPoint": "remove_Occ", "title": "MBPP 011 — Write a python function to remove first and last occurrence of a given character from the string", "oracleDescriptorHash": "sha256:ba48fcc09ef9286b47c3dd0c62f58fb696d02dbfa3014956acbb48f87c4a0cf2"},
  {"problemId": "mbpp-full-012", "upstreamTaskId": "MBPP/12", "taskId": 12, "entryPoint": "sort_matrix", "title": "MBPP 012 — Write a function to sort a given matrix in ascending order according to the sum of its rows", "oracleDescriptorHash": "sha256:d8f364040c76e517a38082cb59927d2b33f1a826de95c5825327ee83fff8cf87"},
  {"problemId": "mbpp-full-014", "upstreamTaskId": "MBPP/14", "taskId": 14, "entryPoint": "find_Volume", "title": "MBPP 014 — Write a python function to find the volume of a triangular prism", "oracleDescriptorHash": "sha256:f34bb7caa71cf2e24001572696469499ce5f27111f0f871d4fee4afd9be0d595"},
  {"problemId": "mbpp-full-016", "upstreamTaskId": "MBPP/16", "taskId": 16, "entryPoint": "text_lowercase_underscore", "title": "MBPP 016 — Write a function to that returns true if the input string contains sequences of lowercase letters joined with an underscore and f", "oracleDescriptorHash": "sha256:923db7d0f81f9878eba31b5da35039e877fe985e9b863d5511b67db98237c0d8"},
  {"problemId": "mbpp-full-017", "upstreamTaskId": "MBPP/17", "taskId": 17, "entryPoint": "square_perimeter", "title": "MBPP 017 — Write a function that returns the perimeter of a square given its side length as input", "oracleDescriptorHash": "sha256:83bf5c573dbf66cc11514418e46d0db303f353015733ad85cdddd9cd3a5d84d4"},
  {"problemId": "mbpp-full-019", "upstreamTaskId": "MBPP/19", "taskId": 19, "entryPoint": "test_duplicate", "title": "MBPP 019 — Write a function to find whether a given array of integers contains any duplicate element", "oracleDescriptorHash": "sha256:53c3ef2afc28a47619f70a250e411d4bfd66fbee91031bc984160cfff28fd77f"},
  {"problemId": "mbpp-full-020", "upstreamTaskId": "MBPP/20", "taskId": 20, "entryPoint": "is_woodall", "title": "MBPP 020 — Write a function to check if the given number is woodball or not", "oracleDescriptorHash": "sha256:ca8a8063462e8486e8c10492e53447cbc366d4439b2c3d50a2ea84cf670d0e50"},
  {"problemId": "mbpp-full-057", "upstreamTaskId": "MBPP/57", "taskId": 57, "entryPoint": "find_Max_Num", "title": "MBPP 057 — Write a python function to find the largest number that can be formed with the given list of digits", "oracleDescriptorHash": "sha256:9bd643f5d6981ffae8461e51c88d50f79ded64e38774180652c161d1effeaf89"},
  {"problemId": "mbpp-full-058", "upstreamTaskId": "MBPP/58", "taskId": 58, "entryPoint": "opposite_Signs", "title": "MBPP 058 — Write a python function to check whether the given two integers have opposite sign or not", "oracleDescriptorHash": "sha256:b679e11ee728fdbf3601b53bb56aa51f7473f307ec8563bc2c92af08980aa885"},
  {"problemId": "mbpp-full-059", "upstreamTaskId": "MBPP/59", "taskId": 59, "entryPoint": "is_octagonal", "title": "MBPP 059 — Write a function to find the nth octagonal number", "oracleDescriptorHash": "sha256:42ca69ea09f7e6bcb43a55e0dea8e92c6203c12383440b80e54cab2a467c389e"},
  {"problemId": "mbpp-full-061", "upstreamTaskId": "MBPP/61", "taskId": 61, "entryPoint": "count_Substrings", "title": "MBPP 061 — Write a python function to count the number of substrings with the sum of digits equal to their length", "oracleDescriptorHash": "sha256:b925588fb686ffe6b7ff56085203630a587dacbdc8f5879af9865ac80bcd104e"},
  {"problemId": "mbpp-full-062", "upstreamTaskId": "MBPP/62", "taskId": 62, "entryPoint": "smallest_num", "title": "MBPP 062 — Write a python function to find smallest number in a list", "oracleDescriptorHash": "sha256:4844f30deea7d1a08c0b40d161b551516891156dfab73bdb46f0be5b41daaf81"},
  {"problemId": "mbpp-full-063", "upstreamTaskId": "MBPP/63", "taskId": 63, "entryPoint": "max_difference", "title": "MBPP 063 — Write a function to find the maximum difference between available pairs in the given tuple list", "oracleDescriptorHash": "sha256:9cc6890f402583d8473e64ff48c57da361f60465707370e21af96e83127289b8"},
  {"problemId": "mbpp-full-064", "upstreamTaskId": "MBPP/64", "taskId": 64, "entryPoint": "subject_marks", "title": "MBPP 064 — Write a function to sort a list of tuples using the second value of each tuple", "oracleDescriptorHash": "sha256:26cd417e960fed3bc534249ad40f3ea8ac83cff8921e92003659cfec72e2bd6c"},
  {"problemId": "mbpp-full-065", "upstreamTaskId": "MBPP/65", "taskId": 65, "entryPoint": "recursive_list_sum", "title": "MBPP 065 — Write a function to flatten a list and sum all of its elements", "oracleDescriptorHash": "sha256:76da43e541b93d12fbd79853c1dacf10ee2b79a5c572a69918604d2dcbec2151"},
  {"problemId": "mbpp-full-066", "upstreamTaskId": "MBPP/66", "taskId": 66, "entryPoint": "pos_count", "title": "MBPP 066 — Write a python function to count the number of positive numbers in a list", "oracleDescriptorHash": "sha256:296f55ad2617aac614c16e6788cd8ba0b6253c000a4c2b6c0813719ff9b4cee3"},
  {"problemId": "mbpp-full-067", "upstreamTaskId": "MBPP/67", "taskId": 67, "entryPoint": "bell_number", "title": "MBPP 067 — Write a function to find the number of ways to partition a set of Bell numbers", "oracleDescriptorHash": "sha256:e41eb1c9aff1ed134ee6a4def880d9514e444a5cc6d6f1726420e65c7f226d64"},
  {"problemId": "mbpp-full-068", "upstreamTaskId": "MBPP/68", "taskId": 68, "entryPoint": "is_Monotonic", "title": "MBPP 068 — Write a python function to check whether the given array is monotonic or not", "oracleDescriptorHash": "sha256:3f608930dad1e612d54ddf9cc04380f1d740b9fac9f3919d0b79b2a074874f5d"},
  {"problemId": "mbpp-full-069", "upstreamTaskId": "MBPP/69", "taskId": 69, "entryPoint": "is_sublist", "title": "MBPP 069 — Write a function to check whether a list contains the given sublist or not", "oracleDescriptorHash": "sha256:9239bcc69f6017d47fb4910a475776328e55e6e643cd5e41f5aa5ccfb4d10483"},
  {"problemId": "mbpp-full-071", "upstreamTaskId": "MBPP/71", "taskId": 71, "entryPoint": "comb_sort", "title": "MBPP 071 — Write a function to sort a list of elements", "oracleDescriptorHash": "sha256:9b0d7145dfb2105d2f97e2043b7ebb7ae787e1c76fe833fad5ea8eb9c67950b9"},
  {"problemId": "mbpp-full-072", "upstreamTaskId": "MBPP/72", "taskId": 72, "entryPoint": "dif_Square", "title": "MBPP 072 — Write a python function to check whether the given number can be represented as the difference of two squares or not", "oracleDescriptorHash": "sha256:d94804d2cebd3e133c5fbbf1a68028fa3e231318cd0127878584a668cbe3080b"},
  {"problemId": "mbpp-full-074", "upstreamTaskId": "MBPP/74", "taskId": 74, "entryPoint": "is_samepatterns", "title": "MBPP 074 — Write a function to check whether it follows the sequence given in the patterns array", "oracleDescriptorHash": "sha256:9a75d4f3d5aae5262281b858204509ceee625ae698276702a87417a642bf9812"},
  {"problemId": "mbpp-full-075", "upstreamTaskId": "MBPP/75", "taskId": 75, "entryPoint": "find_tuples", "title": "MBPP 075 — Write a function to find tuples which have all elements divisible by k from the given list of tuples", "oracleDescriptorHash": "sha256:a9f99c0d69a8fe32928fc6a5e97ae35db0e7faa9d6e51e929124b674eacd03a0"},
  {"problemId": "mbpp-full-077", "upstreamTaskId": "MBPP/77", "taskId": 77, "entryPoint": "is_Diff", "title": "MBPP 077 — Write a python function to find whether a number is divisible by 11", "oracleDescriptorHash": "sha256:eea69a7719997b5956e91f690128b0c78ea99e251bc23e2bc10343f8257c7ce1"},
  {"problemId": "mbpp-full-079", "upstreamTaskId": "MBPP/79", "taskId": 79, "entryPoint": "word_len", "title": "MBPP 079 — Write a python function to check whether the length of the word is odd or not", "oracleDescriptorHash": "sha256:d79a1a354dcd599b69f72d2015875f9502e1dc6bdf7ffd2e1e1eef98ab7011de"},
  {"problemId": "mbpp-full-080", "upstreamTaskId": "MBPP/80", "taskId": 80, "entryPoint": "tetrahedral_number", "title": "MBPP 080 — Write a function to find the nth tetrahedral number", "oracleDescriptorHash": "sha256:d3937e5a0a7109f537fca0980107ea5a885fd820e013bdff0225134e8b36571e"},
  {"problemId": "mbpp-full-083", "upstreamTaskId": "MBPP/83", "taskId": 83, "entryPoint": "get_Char", "title": "MBPP 083 — Write a python function to find the character made by adding the ASCII value of all the characters of the given string modulo 26", "oracleDescriptorHash": "sha256:445b9d8bd74e0b317e2eb0d2b5e08641dafae2c415d16cdc0ae70448f46f4f24"},
  {"problemId": "mbpp-full-084", "upstreamTaskId": "MBPP/84", "taskId": 84, "entryPoint": "sequence", "title": "MBPP 084 — Write a function to find the nth number in the newman conway sequence", "oracleDescriptorHash": "sha256:28f7711247f9162a7e592a817d6a28ea93647a92ccc3e3aba22b6661878033ae"},
  {"problemId": "mbpp-full-086", "upstreamTaskId": "MBPP/86", "taskId": 86, "entryPoint": "centered_hexagonal_number", "title": "MBPP 086 — Write a function to find nth centered hexagonal number", "oracleDescriptorHash": "sha256:a250085f13f4ddc836b6f173d493ba143aac557715869f60ec69747227625bc7"},
  {"problemId": "mbpp-full-087", "upstreamTaskId": "MBPP/87", "taskId": 87, "entryPoint": "merge_dictionaries_three", "title": "MBPP 087 — Write a function to merge three dictionaries into a single dictionary", "oracleDescriptorHash": "sha256:078d6b6a8d8f968dc67c9fa763d0fa91a28fac14921a5de2890c52e8c765f13d"},
  {"problemId": "mbpp-full-088", "upstreamTaskId": "MBPP/88", "taskId": 88, "entryPoint": "freq_count", "title": "MBPP 088 — Write a function to get the frequency of all the elements in a list, returned as a dictionary", "oracleDescriptorHash": "sha256:7aef98b0b837638de526ab6f791d40de04dee8ff2e4266b69f15e910b1091736"},
  {"problemId": "mbpp-full-089", "upstreamTaskId": "MBPP/89", "taskId": 89, "entryPoint": "closest_num", "title": "MBPP 089 — Write a function to find the closest smaller number than n", "oracleDescriptorHash": "sha256:eff0a9f3c151649a762cf0f82b7376a1013d07e7c4c040f41058385c79159def"},
  {"problemId": "mbpp-full-090", "upstreamTaskId": "MBPP/90", "taskId": 90, "entryPoint": "len_log", "title": "MBPP 090 — Write a python function to find the length of the longest word", "oracleDescriptorHash": "sha256:70438550d596f61c530f051c0e6ae67e4906404a22f6c2359dc1d9bf51f97626"},
  {"problemId": "mbpp-full-091", "upstreamTaskId": "MBPP/91", "taskId": 91, "entryPoint": "find_substring", "title": "MBPP 091 — Write a function to check if a string is present as a substring in a given list of string values", "oracleDescriptorHash": "sha256:f3195f38829f3404745f25f6fed61196a958cae663aec974837f041c37185ed4"},
  {"problemId": "mbpp-full-092", "upstreamTaskId": "MBPP/92", "taskId": 92, "entryPoint": "is_undulating", "title": "MBPP 092 — Write a function to check whether the given number is undulating or not", "oracleDescriptorHash": "sha256:fce64d245999ea2ef54dec9ebcbbc5090ed7bc7aa309789b854071dae405a103"},
  {"problemId": "mbpp-full-093", "upstreamTaskId": "MBPP/93", "taskId": 93, "entryPoint": "power", "title": "MBPP 093 — Write a function to calculate the value of 'a' to the power 'b'", "oracleDescriptorHash": "sha256:e2e6d2630583976813c85cebf994c6f0566825f1c31cff14dcf8d92272aa069b"},
  {"problemId": "mbpp-full-094", "upstreamTaskId": "MBPP/94", "taskId": 94, "entryPoint": "index_minimum", "title": "MBPP 094 — Given a list of tuples, write a function that returns the first value of the tuple with the smallest second value", "oracleDescriptorHash": "sha256:c7494cb212f8e804d54c8437e41b76bd31a4a6227f4dd24df76a6aeeaac2a902"},
  {"problemId": "mbpp-full-095", "upstreamTaskId": "MBPP/95", "taskId": 95, "entryPoint": "Find_Min_Length", "title": "MBPP 095 — Write a python function to find the length of the smallest list in a list of lists", "oracleDescriptorHash": "sha256:b0f93a887815fc33e1bab077df3f31d8e012694806d963e31b2ef237573e1bb6"},
  {"problemId": "mbpp-full-096", "upstreamTaskId": "MBPP/96", "taskId": 96, "entryPoint": "divisor", "title": "MBPP 096 — Write a python function to find the number of divisors of a given integer", "oracleDescriptorHash": "sha256:dad297a179bbc281acb1aa9a3598763856737a1619ae343d7f60e6834b49d0a3"},
  {"problemId": "mbpp-full-097", "upstreamTaskId": "MBPP/97", "taskId": 97, "entryPoint": "frequency_lists", "title": "MBPP 097 — Write a function to find frequency of each element in a flattened list of lists, returned in a dictionary", "oracleDescriptorHash": "sha256:3971a115ba5435b0357b17f01339cfe80675000c073376f50c698d66d42f42e7"},
  {"problemId": "mbpp-full-099", "upstreamTaskId": "MBPP/99", "taskId": 99, "entryPoint": "decimal_to_binary", "title": "MBPP 099 — Write a function to convert the given decimal number to its binary equivalent, represented as a string with no leading zeros", "oracleDescriptorHash": "sha256:b43d1bd2d0703ae983fa4aa6e8c9e8b440def97eae15f7a015dec674252b6a75"},
  {"problemId": "mbpp-full-100", "upstreamTaskId": "MBPP/100", "taskId": 100, "entryPoint": "next_smallest_palindrome", "title": "MBPP 100 — Write a function to find the next smallest palindrome of a specified integer, returned as an integer", "oracleDescriptorHash": "sha256:a07cda093f320e5ff81181d33a9430e1dc48064d13d6dc28c53b6e383939c938"},
  {"problemId": "mbpp-full-101", "upstreamTaskId": "MBPP/101", "taskId": 101, "entryPoint": "kth_element", "title": "MBPP 101 — Write a function to find the kth element in the given array using 1-based indexing", "oracleDescriptorHash": "sha256:b6e228d499e55dfcbf73696df4136d83964627c411a8d15196bc015302e86467"},
  {"problemId": "mbpp-full-102", "upstreamTaskId": "MBPP/102", "taskId": 102, "entryPoint": "snake_to_camel", "title": "MBPP 102 — Write a function to convert a snake case string to camel case string", "oracleDescriptorHash": "sha256:293f5360c8b481aee07ad808b2d18018bae6b95d824497f61cf80c3b5d03a2fc"},
  {"problemId": "mbpp-full-103", "upstreamTaskId": "MBPP/103", "taskId": 103, "entryPoint": "eulerian_num", "title": "MBPP 103 — Write a function to find the Eulerian number a(n, m)", "oracleDescriptorHash": "sha256:65cd1a1c1b604daea8ad284669f819adf0a05a228054502f909eacdd1fe41f62"},
  {"problemId": "mbpp-full-104", "upstreamTaskId": "MBPP/104", "taskId": 104, "entryPoint": "sort_sublists", "title": "MBPP 104 — Write a function to sort each sublist of strings in a given list of lists", "oracleDescriptorHash": "sha256:9b90a65665d5a743f724f7718fa7f0ab2600857aa0cc422121802e03c30a3965"},
] as const satisfies readonly MbppSubsetManifestEntry[];

export function mbppSubsetScoredProblems(benchmarkId: string, adapterId: string): Problem[] {
  return MBPP_SUBSET_ORACLE_MANIFEST.map((entry) => ({
    id: entry.problemId,
    benchmarkId,
    adapterId,
    upstreamTaskId: entry.upstreamTaskId,
    title: entry.title,
    languageFrameworkTags: ["python", "mbpp", "scored-hidden"],
    hostingMode: "hosted",
    enabled: true,
    editableFilePaths: ["solution.py"],
    scoringMode: "scored-hidden",
    oracleMetadata: {
      kind: "hidden-fixture",
      hiddenRequired: true,
      oracleDescriptorHash: entry.oracleDescriptorHash,
    },
  }));
}
