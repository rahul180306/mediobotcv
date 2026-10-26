import { describe, it, expect } from 'vitest';
import { actionParser, parseActionVlm } from '../src/actionParser';
import { UITarsModelVersion } from '@ui-tars/shared/types';
import { parseBoxToScreenCoords } from '../../sdk/src/utils';

describe('Clicking Accuracy Regression Tests', () => {
  describe('Case 1: Failed Google Search-Box Task (BrowserOperator)', () => {
    const googleSearchBoxModelOutput = `Thought: Let me try clicking directly on the search input field and wait to see if it gets focus.

Action: Click on the Google search box input field.
start_box='<|box_start|>(500,450)<|end_box|>'
end_box='<|box_start|>(500,450)<|end_box|>'`;

    it('should correctly parse external-model action syntax without function call error', () => {
      const parsed = parseActionVlm(
        googleSearchBoxModelOutput,
        [1000, 1000],
        'bc',
        { width: 2560, height: 1600 },
        2,
        UITarsModelVersion.V1_0,
      );

      expect(parsed).toHaveLength(1);
      const action = parsed[0];
      expect(action.action_type).toBe('click');
      expect(action.action_inputs.start_box).toBe('[0.5,0.45,0.5,0.45]');
    });

    it('should transform coordinates accurately to CSS viewport with Retina 2x scaling', () => {
      const screenWidth = 2560; // Puppeteer Retina physical width
      const screenHeight = 1600; // Puppeteer Retina physical height
      const deviceScaleFactor = 2; // macOS Retina scale

      const { parsed } = actionParser({
        prediction: googleSearchBoxModelOutput,
        factor: [1000, 1000],
        screenContext: { width: screenWidth, height: screenHeight },
        scaleFactor: deviceScaleFactor,
        modelVer: UITarsModelVersion.V1_0,
      });

      expect(parsed).toHaveLength(1);
      const action = parsed[0];

      // Physical image pixel coordinates
      const coords = parseBoxToScreenCoords({
        boxStr: action.action_inputs.start_box as string,
        screenWidth,
        screenHeight,
      });
      expect(coords.x).toBe(1280);
      expect(coords.y).toBe(720);

      // Browser CSS viewport coordinates (used by page.mouse.click)
      const cssX = coords.x! / deviceScaleFactor;
      const cssY = coords.y! / deviceScaleFactor;

      // In a 1280x800 viewport, the Google search box center is at (640, 360)
      expect(cssX).toBe(640);
      expect(cssY).toBe(360);
    });
  });

  describe('Case 2: Chrome Dock Icon Task (NutJSOperator)', () => {
    const dockModelOutput = `Thought: I need to click the Chrome icon on the dock to open the browser.

Action: click(start_box='<|box_start|>(666,951)<|box_end|>')`;

    it('should not compress coordinates with smartResizeForV15 when using V1_0 normalized convention', () => {
      const screenWidth = 1470; // macOS logical display width
      const screenHeight = 956; // macOS logical display height

      const { parsed } = actionParser({
        prediction: dockModelOutput,
        factor: [1000, 1000],
        screenContext: { width: screenWidth, height: screenHeight },
        scaleFactor: 1,
        modelVer: UITarsModelVersion.V1_0,
      });

      expect(parsed).toHaveLength(1);
      const action = parsed[0];
      expect(action.action_type).toBe('click');
      expect(action.action_inputs.start_box).toBe('[0.666,0.951,0.666,0.951]');

      // NutJS operates in logical points (1470x956)
      const coords = parseBoxToScreenCoords({
        boxStr: action.action_inputs.start_box as string,
        screenWidth,
        screenHeight,
      });

      // Expected click position: x = 0.666 * 1470 = 979, y = 0.951 * 956 = 909
      expect(coords.x).toBeCloseTo(979.02, 1);
      expect(coords.y).toBeCloseTo(909.156, 1);

      // Verify it does NOT produce the bugged coordinate (659.7, 955.0) which clicked the wrong dock icon
      expect(coords.x).not.toBeCloseTo(659.7, 0);
    });
  });

  describe('Case 3: Strict Rejection of Malformed / Out-of-Range Actions', () => {
    it('should reject actions with out-of-range coordinates [0, 1000]', () => {
      const input = `Thought: Click out of bounds
Action: click(start_box='(-50, 1500)')`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );

      // Action with out-of-range coordinates must be rejected
      expect(result).toHaveLength(0);
    });

    it('should reject click actions with missing coordinates', () => {
      const input = `Thought: Click without coordinates
Action: click()`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );

      // Action without required coordinates must be rejected
      expect(result).toHaveLength(0);
    });

    it('should reject ambiguous instructions rather than guessing', () => {
      const input = `Thought: Ambiguous instruction
Action: do_something_random(target='button')`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );

      expect(result).toHaveLength(0);
    });
  });

  describe('Case 4: Preservation of UI-TARS 1.5 Coordinate Handling', () => {
    it('should preserve smartResizeForV15 for official UI-TARS 1.5 weights', () => {
      const input = `Thought: Click using UI-TARS 1.5
Action: click(start_box='<|box_start|>(742,483)<|box_end|>')`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        { width: 1470, height: 956 },
        1,
        UITarsModelVersion.V1_5,
      );

      expect(result).toHaveLength(1);
      const action = result[0];
      expect(action.action_type).toBe('click');
      // For 956x1470, smartResizeFactors is [1484, 952]
      // 742 / 1484 = 0.5, 483 / 952 = ~0.507
      const coords = JSON.parse(action.action_inputs.start_box as string);
      expect(coords[0]).toBeCloseTo(0.5, 2);
    });
  });

  describe('Case 5: Positional, Named Typing and Escaped Newlines (DiffusionGemma Compatibility)', () => {
    it('should parse positional typing type(\'youtube\\n\') without discarding content', () => {
      const input = `Thought: I will type youtube and press Enter to search.
Action: type('youtube\n')`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );

      expect(result).toHaveLength(1);
      expect(result[0].action_type).toBe('type');
      expect(result[0].action_inputs.content).toBe(String.raw`youtube\n`);
    });

    it('should safely unescape escaped newlines type(\'youtube\\\\n\') and preserve newline submission', () => {
      const input = `Thought: Type with literal escaped newline.
Action: type('youtube\\n')`;

      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );

      expect(result).toHaveLength(1);
      expect(result[0].action_type).toBe('type');
      expect(result[0].action_inputs.content).toBe(String.raw`youtube\n`);
    });

    it('should parse named typing type(content=\'youtube\\n\') and type(text=\'youtube\\n\')', () => {
      const inputContent = `Action: type(content='youtube\n')`;
      const result1 = parseActionVlm(
        inputContent,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );
      expect(result1).toHaveLength(1);
      expect(result1[0].action_inputs.content).toBe(String.raw`youtube\n`);

      const inputText = `Action: type(text='search query\\n')`;
      const result2 = parseActionVlm(
        inputText,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );
      expect(result2).toHaveLength(1);
      expect(result2[0].action_inputs.text).toBe(String.raw`search query\n`);
    });

    it('should support escaped quotes and commas inside typed content', () => {
      const input = `Action: type('it\\'s a test, with comma\\n')`;
      const result = parseActionVlm(
        input,
        [1000, 1000],
        'bc',
        undefined,
        undefined,
        UITarsModelVersion.V1_0,
      );
      expect(result).toHaveLength(1);
      expect(result[0].action_inputs.content).toBe(
        String.raw`it's a test, with comma\n`,
      );
    });
  });

  describe('Case 6: Bounding-Box Center Scaling and Zero Coordinates', () => {
    it('should map [237,423,762,480] to [1278.72, 722.4] without double-scaling on Retina 2x displays', () => {
      const input = `Thought: Click search button
Action: click(start_box='[237,423,762,480]')`;

      const screenWidth = 2560;
      const screenHeight = 1600;
      const deviceScaleFactor = 2;
      const logicalWidth = screenWidth / deviceScaleFactor;
      const logicalHeight = screenHeight / deviceScaleFactor;

      const { parsed } = actionParser({
        prediction: input,
        factor: [1000, 1000],
        screenContext: { width: logicalWidth, height: logicalHeight },
        scaleFactor: deviceScaleFactor,
        modelVer: UITarsModelVersion.V1_0,
      });

      expect(parsed).toHaveLength(1);
      const action = parsed[0];

      // Verify start_coords does NOT become double-scaled [2557.44, 1444.8]
      expect(action.action_inputs.start_coords).toEqual([1278.72, 722.4]);

      // Verify browser CSS viewport coordinates are calculated correctly:
      const coords = parseBoxToScreenCoords({
        boxStr: action.action_inputs.start_box as string,
        screenWidth,
        screenHeight,
      });
      expect(coords.x).toBe(1278.72);
      expect(coords.y).toBe(722.4);

      const cssX = coords.x! / deviceScaleFactor;
      const cssY = coords.y! / deviceScaleFactor;
      expect(cssX).toBeCloseTo(639.36, 2);
      expect(cssY).toBeCloseTo(361.2, 2);
    });

    it('should handle zero coordinates [0, 0, 0, 0] without dropping or failing', () => {
      const input = `Thought: Click top-left corner
Action: click(start_box='[0,0,0,0]')`;

      const { parsed } = actionParser({
        prediction: input,
        factor: [1000, 1000],
        screenContext: { width: 1920, height: 1080 },
        scaleFactor: 1,
        modelVer: UITarsModelVersion.V1_0,
      });

      expect(parsed).toHaveLength(1);
      expect(parsed[0].action_inputs.start_box).toBe('[0,0,0,0]');
      expect(parsed[0].action_inputs.start_coords).toEqual([0, 0]);
    });
  });
});
