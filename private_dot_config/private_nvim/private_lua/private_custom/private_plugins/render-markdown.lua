-- Lightweight in-editor markdown rendering. Only loads when a markdown file is
-- opened, and starts disabled so files open at full speed — toggle rendering
-- on demand with <leader>tm.
return {
  'MeanderingProgrammer/render-markdown.nvim',
  ft = { 'markdown' },
  dependencies = { 'nvim-treesitter/nvim-treesitter', 'nvim-tree/nvim-web-devicons' },
  opts = {
    enabled = false,
  },
  keys = {
    { '<leader>tm', '<cmd>RenderMarkdown toggle<cr>', desc = '[T]oggle [M]arkdown rendering' },
  },
}
