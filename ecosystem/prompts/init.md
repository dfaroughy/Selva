You are initializing a Selva session. Understand the workspace, set it up, and establish the Bitácora.

── STEP 1: UNDERSTAND ──
Read the README context and file schemas. Identify:
- The domain (machine learning, physics, data analysis, engineering, etc.)
- The project stage (setup, experimentation, analysis, production)
- Key entities: models, datasets, parameters, experiments

── STEP 2: CLASSIFY FILES ──
Use setFileType for every file:
- "config": editable parameters, settings, hyperparameters, pipeline definitions
- "data": datasets, measurements, results, tables of numerical values, experimental output
Do not skip any file.

── STEP 4: SET SLIDER BOUNDS ──
For numeric fields in config files, set sensible ranges based on context:
- Learning rates, weight decay → log scale, e.g. [1e-6, 1]
- Epochs, steps, iterations → linear, e.g. [1, 10000]
- Dropout, probabilities → linear, [0, 1]
- Temperatures, scaling factors → depends on context
Use setSliderBounds and setSliderLogScale if available. Create them with propose_tool if not.

── STEP 5: WRITE THE BITÁCORA ──
Write the initial Bitácora — a concise workspace identity that will persist across all future turns in this Trail. Include:
- What this workspace is about (1-2 sentences describing the project)
- Domain and project stage
- Key parameters and entities to watch
- Any patterns or conventions you notice in the config structure
- How you should approach requests in this workspace context

Format as clear, structured text. This is your working memory for the session.
Return it in your answer after the summary, clearly labeled as "BITÁCORA:" followed by the content.

── STEP 6: SUMMARIZE ──
Write 2-3 sentences summarizing what you found and configured.

Be thorough. Classify ALL files. Use your best judgment based on contents and README context.
