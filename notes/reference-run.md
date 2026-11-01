REFERENCE RUN - Utopia under WinUAE (observation only)
=======================================================

Scope
-----
Passive observation of the WinUAE window that was already running when observation began.
No keyboard, mouse or other synthetic input was sent. No emulator or other application was
started, stopped, restarted or reconfigured. No sound was used. Nothing under
C:\Users\Public\Documents\Amiga Files\WinUAE was touched, and original\ was not touched.
Screens are described in our own words only; no game text, graphics or music is copied here.

Observation method
------------------
- Capture script: scratchpad\shot.ps1 (PrintWindow on the winuae64 main window, no input).
- 16 captures, one roughly every 21 seconds, covering about 5 minutes (t = 0 s to about 315 s).
- PNGs saved in scratchpad\observe\cap_00.png to cap_15.png (with timestamps.txt).
- Each capture was viewed individually. Times below are approximate seconds since capture 0.
- Window title during the run: "[utopia_whd2.uae] - WinUAE". The winuae64 process started at
  15:52:06 (local time) and was already running when observation began.

Timeline of observed screens
----------------------------
Common to all frames: the title picture (large stone-style game logo with a purple creature
above it, a red subtitle bar, and a version and copyright line along the bottom) stays on
screen unchanged. The title art and background never move in any capture. Only the text area
below the title changes. The WinUAE status bar at the bottom changes every frame (CPU and FPS
counters), which is emulator UI and not game output.

  t ~   0 s  cap_00  title art; a graphics credit line in the text area.
  t ~  21 s  cap_01  title art; a prompt asking the player to press the left mouse button.
  t ~  42 s  cap_02  title art; only a small partial glyph visible in the text area
                     (text being drawn or cleared).
  t ~  63 s  cap_03  title art; a design credit line.
  t ~  84 s  cap_04  title art only; text area empty.
  t ~ 105 s  cap_05  title art; the mouse-button prompt partially drawn (being typed in).
  t ~ 126 s  cap_06  title art; a music and sound-effects credit line.
  t ~ 147 s  cap_07  title art; the design credit line again.
  t ~ 168 s  cap_08  title art; a programming credit line.
  t ~ 189 s  cap_09  title art; a publisher/production line.
  t ~ 210 s  cap_10  title art; a line naming an additional contributor.
  t ~ 231 s  cap_11  title art; the graphics credit line again.
  t ~ 252 s  cap_12  title art only; text area empty.
  t ~ 273 s  cap_13  title art; the publisher/production line partially drawn.
  t ~ 294 s  cap_14  title art; the contributor line again.
  t ~ 315 s  cap_15  title art only; text area empty.

Interpretation
--------------
- This is the intro/title screen. It shows a looping credit roll with a mouse-button prompt.
  Credit lines recur (for example the graphics line at about 0 s and about 231 s), so the
  sequence cycles. The exact period cannot be resolved at about 21 second sampling.
- Static vs animated: the title art is static. The lower text area animates (text types in,
  holds, clears, and repeats). The whole picture is therefore animated in its text region only.
- No menu, options screen, game-map screen, gameplay, or response to input was seen in
  approximately 5 minutes. The screen never progressed beyond this intro loop unattended.
- Screen geometry: the picture is a fixed-size display inside the WinUAE window with black
  borders. The game picture stays in the same place in every capture.

Reproduction recipe (verified against files at observation time)
-----------------------------------------------------------------
1. Emulator binary: scratchpad\wdev\winuae64.exe. File version verified as 6.0.3.0.
   Full path: C:\Users\Caldor\AppData\Local\Temp\claude\C--LLM\30eb73f3-1ec3-43d7-b792-e59f8ade9fa2\scratchpad\wdev\winuae64.exe

2. Configuration: scratchpad\wdev\utopia_whd2.uae. Verified contents:
   - cpu_model=68020, cpu_speed=max, chipset=aga
   - chipmem_size=3 (2 MB chip RAM), fastmem_size=4 (4 MB fast RAM), bogomem_size=0
   - nr_floppies=0 (no floppy drives)
   - sound_output=none
   - Kickstart ROM: E:\Games\Emulator\Amiga\Amiga Forever\Shared\rom\amiga-os-310-a1200.rom
     (Kickstart 3.1 for A1200). The file exists.
   - Kickstart key file: E:\Games\Emulator\Amiga\Emulation\WinUAE\rom.key. The file exists.
   - Boot volume: filesystem2=ro,UT:UT:<scratchpad>\wboot,0
     (read-only host folder mounted as bootable volume UT:).
   The boot log (scratchpad\wdev\winuaebootlog.txt) reports "KS ver = 40", which matches 3.1.

3. Boot folder: scratchpad\wboot. Verified contents:
   - S\Startup-Sequence (106 bytes), three lines:
       Assign LIBS: UT:Libs ADD
       CD UT:Utopia
       UT:C/WHDLoad Utopia.Slave
   - C\WHDLoad (162674 bytes) and C\Assign.
   - Libs\xpkmaster.library.
   - S\WHDLoad.key (888 bytes). This is the owner's key file. Its contents are not copied here.
   - Utopia\Utopia.Slave (1264 bytes) and the game data files.
   - scratchpad\whd201 holds a WHDLoad 20.1 package. Its version was not compared byte for byte
     against C\WHDLoad.

4. Nag window: the WHDLoad key file in S: is what suppresses the WHDLoad nag window, per the
   owner's setup. This was not directly observed. No nag dialog appeared in any capture.

5. Start: the emulator was already running at observation time. The Start step (the WinUAE
   Start button) was not performed in this session. If it ever needs repeating, the owner's
   rule is that the in-app Start button is clicked only through UI Automation InvokePattern.
   That method was not used here.

Could NOT be done (input is forbidden)
--------------------------------------
- Get past the title and intro: the prompt asks for a left mouse click, and that click was not sent.
- Start the game, use menus, reach the game map, or play.
- Verify any gameplay, saving, loading or game-over behaviour.
- Restart the emulator for a clean boot, to confirm the full boot path from power-on.
- Check whether the WHDLoad nag window is suppressed by observation. It is inferred from the
  key file being present and from the absence of a dialog in the captures.
- Check audio. The configuration has sound_output=none, so this was not tested.
- Determine the exact period of the credit loop. Sampling at about 21 seconds is too coarse.

Files
-----
- This notes file: C:\LLM\remake\Utopia\notes\reference-run.md
- Captures: C:\Users\Caldor\AppData\Local\Temp\claude\C--LLM\30eb73f3-1ec3-43d7-b792-e59f8ade9fa2\scratchpad\observe\cap_00.png ... cap_15.png
- Capture log: C:\Users\Caldor\AppData\Local\Temp\claude\C--LLM\30eb73f3-1ec3-43d7-b792-e59f8ade9fa2\scratchpad\observe\timestamps.txt
- Nothing committed. No files under original\ were modified.
