# Change Log

## 0.13.0

- Fixed reading and saving image, audio, and video SDS metadata files that do not define scalar data channels.
- Added playback controls to the image viewer, using the stream sample frequency as the playback frame rate.
- Aligned SDS and SDSIO schemas, snippets, generated sample projects, and metadata templates with SDS Framework 3.1.0 metadata fields.
- Improved SDS sample timing for records containing multiple frames and corrected displayed recording intervals for custom tick frequencies.
- Improved decoding of truncated image data so incomplete RAW8, Bayer, and grayscale frames remain viewable.
- Improved SDS Explorer refresh behavior so recorded file sizes and flag changes update without unnecessary full tree refreshes.
- Disabled SDSIO record and play controls when the extension is not connected to the SDSIO server.
- Synchronized media viewer playback controls for matching SDS recordings and timestamps.
- Updated SDSIO play, record, and stop command state when recording or playback is started and stopped by the connected hardware.
- Improved chart layout resizing and initial cursor synchronization in data and audio viewers.
- Improved security handling for metadata/config file creation and webview message validation.
- Improved CMSIS pack root discovery for SDS Check by falling back to the default pack cache location and showing clearer errors.
- Updated README usage guidance and screenshots.
- Improved audio playback to play only the visible range.
- Improved image stream playback to stop at the final frame instead of looping.

## 0.11.0

- Combined SDSIO Flags and SDS Explorer into one streamlined control.
- Improved file and SDS group handling in Explorer.
- Streamlined SDS actions, menus, and context commands.
- Added actions to ellipsis menu to open and close an SDS configuration.
- Added support for SDS stream labels.
- Added schema based validation and auto-completion support in editor for `sdsio.yml` and `sds.yml` files.
- Added SDS Check action for `.sds` files.
- Enhanced data and audio viewers with new line chart interactions.
- Improved cursor synchronization between media and data views.
- Improved SDSIO terminal startup, shutdown, and PowerShell handling.
- Improved SDSIO terminal handling/shutdown behavior, if users launch or stop SDSIO from VS Code.
- Updated SDS Framework / SDSIO tooling support, if this changes compatibility or bundled tool behavior.
- Improved diagnostic output formatting, if users see validation/check results.

## 0.9.0

- First public release of the extension.
- Improve/reactify component.
  - Synchronize Data Views with Media Viewers (video, image, audio).
  - Add a new Audio Media Viewer.
  - Include sdsio-server component.
  - Add Server UI Controlls to sdsio-server (Record/Playback/Stop, Flags).
- Fix package name and publisher in package.json.
- Remove transparent background of PNG icon.
- Update extension icon to use new Arm marketplace image.
- Update SDS file handling to support optional '.p' suffix in regex patterns.

## 0.8.1.34

- Initial private release of extension pack on GitHub.
