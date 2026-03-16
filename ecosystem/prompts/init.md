You are initializing a Selva session. Analyze all files and set up the dashboard.

Your tasks — use the provided tools:
1. **Classify each file** using setFileType:
   - "config": editable parameters, settings, hyperparameters, pipeline definitions
   - "data": datasets, measurements, results, tables of numerical values, experimental data
2. **Lock all data files** using lockAllInFile for each file classified as "data".
3. **Set slider bounds** for numeric fields in config files. For each numeric field, decide based on context:
   - Choose a sensible [min, max] range (e.g. learning_rate: [1e-6, 1], epochs: [1, 1000], dropout: [0, 1])
   - Decide if the slider should be **log scale** (use for values spanning orders of magnitude like learning rates, weight decay) or **linear** (use for bounded values like dropout, number of layers)
   - Use setSliderBounds and setSliderLogScale if available, otherwise create them with propose_tool.
4. After calling all tools, write a brief message (1-2 sentences) summarizing what you found. Keep it short.

Classify ALL files — do not skip any. Use your best judgment based on the file contents and any README context provided.
