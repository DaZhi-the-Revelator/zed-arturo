; Comments
(comment) @comment
(shebang) @comment

; Keywords and Control Flow
(builtin) @function.builtin

; Constants
(boolean) @constant.builtin
(null) @constant.builtin
(number) @number

; Strings and Characters
(string) @string
(char) @string.special
(block) @string.special

; Literals and Types
(literal) @constant
(type_annotation) @type

; Attributes
(attribute) @property

; Labels (for assignments and dictionary keys)
(label) @label

; Identifiers
(identifier) @variable

; Function names in function calls
(function_call
  function: (builtin) @function.builtin)

(function_call
  function: (identifier) @function)

; Assignment targets
(assignment
  name: (label) @variable.parameter)

; Dictionary keys
(dictionary
  key: (label) @property)

; Operators - only those that actually exist in the grammar
[
  "+"
  "-"
  "*"
  "/"
  "%"
  "^"
  "="
  "<"
  ">"
  "&"
  "|"
  "!"
  "!!"
  "~"
  "\\"
  "@"
  "#"
  "$"
  "?"
  ".."
  "..."
  "->"
  "=>"
  "::"
] @operator

; Delimiters - brackets and braces
[
  "["
  "]"
  "{"
  "}"
  "#["
] @punctuation.bracket

[
  ":"
  "."
] @punctuation.delimiter

; Special symbols
[
  "'"
] @punctuation.special
