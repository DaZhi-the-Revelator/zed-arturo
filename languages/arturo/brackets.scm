; Bracket pairs for rainbow brackets feature in Zed
; These define matching bracket pairs that will be colored
; based on nesting depth when users enable colorize_brackets

; Block brackets: [...]
(block "[" @open "]" @close)

; Dictionary brackets: #[...]
(dictionary "#[" @open "]" @close)
