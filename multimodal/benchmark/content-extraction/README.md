# Content Extraction Benchmark

This benchmark evaluates different content extraction strategies for web pages, focusing on performance, content quality, and token efficiency. It's designed to address out-of-memory issues with large web pages and improve the quality of extracted content for LLM processing.

```md
📋 Benchmark Results

┌─────────────────────┬───────────────┬───────────────┬───────────────┬───────────────┐ │ Strategy │ Avg Time (ms) │ Min Time (ms) │ Max Time (ms) │ Std Dev (ms) │ ├─────────────────────┼───────────────┼───────────────┼───────────────┼───────────────┤ │ RawContent │ 492.42 │ 247.29 │ 758.27 │ 212.19 │ │ CurrentMarkdown │ 494.47 │ 287.30 │ 707.46 │ 206.10 │ │ Readability │ 622.49 │ 271.61 │ 1103.75 │ 334.54 │ │ Optimized │ 588.73 │ 271.24 │ 1084.25 │ 318.71 │ └─────────────────────┴───────────────┴───────────────┴───────────────┴───────────────┘

┌─────────────────────┬───────────────┬───────────────┬───────────────┐ │ Strategy │ Original Len │ Extracted Len │ Token Count │ ├─────────────────────┼───────────────┼───────────────┼───────────────┤ │ RawContent │ 829,024 │ 486,823 │ 153,825 │ │ CurrentMarkdown │ 829,024 │ 127,360 │ 29,623 │ │ Readability │ 829,024 │ 136,209 │ 35,457 │ │ Optimized │ 829,024 │ 284,810 │ 79,581 │ └─────────────────────┴───────────────┴───────────────┴───────────────┘

📉 Compression Ratios (compared to original content)

┌─────────────────────┬───────────────┬───────────────┐ │ Strategy │ Length Ratio │ Token Ratio │ ├─────────────────────┼───────────────┼───────────────┤ │ RawContent │ 58.72% │ 100.00% │ │ CurrentMarkdown │ 15.36% │ 19.26% │ │ Readability │ 16.43% │ 23.05% │ │ Optimized │ 34.35% │ 51.73% │ └─────────────────────┴───────────────┴───────────────┘

📝 Strategy Descriptions

RawContent: Extracts raw page content without any processing, serving as baseline for comparison.

CurrentMarkdown: Current browser_get_markdown implementation that extracts page content and converts to markdown.

Readability: Uses Mozilla's Readability library to extract main content while removing navigation, ads, and non-essential elements.

Optimized: Universal content extraction using advanced algorithms to identify and extract the most valuable content while preserving semantic structure and optimizing for token efficiency.
```

## Background

When processing web content for LLMs, efficient content extraction is crucial for several reasons:

1. **Memory constraints**: Raw HTML content from modern websites can be extremely large, causing out-of-memory issues in extraction pipelines.

2. **Token efficiency**: LLMs have token limits and token processing costs. Extracting only relevant content reduces token usage and improves cost efficiency.

3. **Content quality**: Better extraction techniques preserve semantic structure (headings, lists, code blocks) while removing noise (ads, navigation, etc.), improving the quality of LLM inputs.

This benchmark compares multiple extraction strategies to find the optimal balance between these factors.

## Strategies

The benchmark evaluates four different content extraction strategies:

1. **RawContent**: Extracts the raw HTML content without processing (baseline for comparison).

2. **CurrentMarkdown**: Simulates the current browser_get_markdown implementation, which extracts content and converts to markdown.

3. **Readability**: Uses Mozilla's Readability library to extract the main content while removing navigation, ads, and other non-essential elements.

4. **Optimized**: An advanced implementation using content density analysis, semantic structure preservation, and multi-stage fallback mechanisms.

## Metrics Explained

### Performance Metrics

- **Avg Time (ms)**: Average execution time in milliseconds across multiple runs
- **Min Time (ms)**: Minimum execution time observed
- **Max Time (ms)**: Maximum execution time observed
- **Std Dev (ms)**: Standard deviation of execution times, indicating consistency

### Content Metrics

- **Original Len**: Length in characters of the original HTML content
- **Extracted Len**: Length in characters of the extracted content
- **Token Count**: Number of tokens in the extracted content (using cl100k_base tokenizer)

### Efficiency Metrics

- **Length Ratio**: Percentage of extracted content length compared to original content
- **Token Ratio**: Percentage of tokens compared to the baseline strategy (RawContent)

### Optional Metrics

- **Memory Usage (MB)**: Peak memory consumption when enabled with --expose-gc flag

## Usage

Run the benchmark with default URLs:

```
npm run benchmark
```

Run with a custom URL:

```
npm run benchmark https://example.com
```

Save results to disk:

```
npm run benchmark --save
```

## Interpreting Results

- **Lower execution time** indicates better performance
- **Lower extracted length** generally indicates better noise removal
- **Lower token count** means more efficient LLM processing
- **Higher content quality** (subjective) can be evaluated by examining the extracted content

The optimal strategy balances these factors based on your specific requirements.
