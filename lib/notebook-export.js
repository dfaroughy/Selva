function splitLines(text) {
  // nbformat stores source as array of lines, each ending with \n except possibly the last
  if (!text) return [];
  const lines = String(text).split(/\n/);
  return lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
}

function cellToIpynb(cell, nextCell) {
  // nextCell is used to attach image outputs to the preceding python cell
  if (cell.type === 'markdown') {
    return {
      cell_type: 'markdown',
      metadata: {},
      source: splitLines(cell.content || ''),
    };
  }
  if (cell.type === 'python') {
    const outputs = [];
    const output = String(cell.output || '').trim();
    if (output) {
      // Check if it looks like an error
      const isError = /^Error \(exit\s+\d+\):|^Execution error:|Traceback \(most recent call last\):/i.test(output);
      if (isError) {
        outputs.push({
          output_type: 'error',
          ename: 'ExecutionError',
          evalue: output.split('\n')[0] || '',
          traceback: output.split('\n'),
        });
      } else {
        outputs.push({
          output_type: 'stream',
          name: 'stdout',
          text: splitLines(output),
        });
      }
    }
    // If the next cell is an image, attach it as display_data
    if (nextCell && nextCell.type === 'image' && nextCell.data) {
      outputs.push({
        output_type: 'display_data',
        data: { 'image/png': nextCell.data },
        metadata: {},
      });
    }
    return {
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: splitLines(cell.code || ''),
      outputs,
    };
  }
  // standalone image (not attached to a python cell) -> markdown with embedded image
  if (cell.type === 'image' && cell.data) {
    return {
      cell_type: 'markdown',
      metadata: {},
      source: ['![output](data:image/png;base64,' + cell.data.slice(0, 40) + '...)\n'],
    };
  }
  return null;
}

function exportToIpynb(cells, metadata = {}) {
  const nbCells = [];
  const skipIndices = new Set();

  for (let i = 0; i < cells.length; i++) {
    if (skipIndices.has(i)) continue;
    const cell = cells[i];
    if (!cell) continue;

    // Look ahead: if this is a python cell and next is an image, attach the image
    const nextCell = i + 1 < cells.length ? cells[i + 1] : null;
    const attachImage = cell.type === 'python' && nextCell && nextCell.type === 'image';

    const nbCell = cellToIpynb(cell, attachImage ? nextCell : null);
    if (nbCell) {
      nbCells.push(nbCell);
      if (attachImage) skipIndices.add(i + 1);
    }
  }

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: '3.x',
      },
      ...(metadata.selva ? { selva: metadata.selva } : {}),
    },
    cells: nbCells,
  };
}

function exportToPython(cells) {
  const blocks = [];

  for (const cell of cells) {
    if (!cell) continue;
    if (cell.type === 'markdown' && cell.content) {
      const commented = String(cell.content)
        .split('\n')
        .map(line => '# ' + line)
        .join('\n');
      blocks.push(commented);
    } else if (cell.type === 'python' && cell.code) {
      blocks.push(String(cell.code));
    }
    // skip image cells in .py export
  }

  return blocks.join('\n\n') + '\n';
}

module.exports = {
  exportToIpynb,
  exportToPython,
  splitLines,
};
