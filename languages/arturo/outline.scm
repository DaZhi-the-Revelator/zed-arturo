; Outline query for Arturo language
; This query defines what symbols appear in the outline view and breadcrumbs

; Function definitions (assignments where value is a block)
; These are marked with @context to include the block indicator in the outline
(assignment
  name: (label
    identifier: (identifier) @name)
  value: (block) @context) @item

; Variable/constant assignments (non-block values)
(assignment
  name: (label
    identifier: (identifier) @name)
  value: (_)) @item
