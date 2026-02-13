; Tags query for Arturo language
; Defines symbols for Project Symbols (Ctrl+T), Go to Definition, and workspace-wide symbol search

; Function definitions (assignments where value is a block)
(assignment
  name: (label
    identifier: (identifier) @name)
  value: (block)) @definition.function

; Variable/constant assignments
(assignment
  name: (label
    identifier: (identifier) @name)) @definition.variable

; Built-in function calls (for reference tracking)
(function_call
  function: (builtin) @name) @reference.call

; User-defined function calls (for reference tracking)
(function_call
  function: (identifier) @name) @reference.call
