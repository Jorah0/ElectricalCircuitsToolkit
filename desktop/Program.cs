using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CircuitToolkit;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

sealed class MainForm : Form
{
    // Private https origin mapped to the extracted files (".example" is reserved, so it can't clash with a real site).
    const string Host = "circuit-toolkit.example";
    readonly WebView2 web = new() { Dock = DockStyle.Fill };

    public MainForm()
    {
        Text = "Circuit Toolkit";
        Size = new Size(1400, 900);
        StartPosition = FormStartPosition.CenterScreen;
        using (var ico = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico")!) Icon = new Icon(ico); // all sizes, so title bar and taskbar stay crisp
        Controls.Add(web);
        Load += async (_, _) => await StartAsync();
    }

    async Task StartAsync()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CircuitToolkit");
        var site = Path.Combine(root, "web");
        ExtractWebApp(site);
        try
        {
            // Fixed profile folder: keeps the autosaved circuit and settings between launches.
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(root, "WebView2"));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Circuit Toolkit needs the Microsoft Edge WebView2 Runtime, which is missing on this PC.\n\n" +
                "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start the app again.",
                "Circuit Toolkit", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var core = web.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(Host, site, CoreWebView2HostResourceAccessKind.Allow);
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no F5/Ctrl+R reloads or Ctrl+P; editing keys still work

        // Links open in the default browser; the app window only ever shows the app
        // (this also stops a file dropped outside the canvas from replacing the page).
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        // Exports (SVG/PNG/CSV/netlist) and browsers-without-file-pickers saves arrive as downloads: ask where to put them.
        core.DownloadStarting += (_, e) =>
        {
            using var dlg = new SaveFileDialog { FileName = Path.GetFileName(e.ResultFilePath), OverwritePrompt = true };
            if (dlg.ShowDialog(this) == DialogResult.OK) { e.ResultFilePath = dlg.FileName; e.Handled = true; }
            else e.Cancel = true;
        };

        // Interface scale: the page asks for a zoom level (Ctrl + / − / 0); Ctrl+wheel zoom is reported back to it.
        core.WebMessageReceived += (_, e) =>
        {
            if (!e.Source.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                if (doc.RootElement.TryGetProperty("zoom", out var z) && z.TryGetDouble(out var f)) web.ZoomFactor = Math.Clamp(f, 0.5, 2.5);
            }
            catch (JsonException) { }
        };
        web.ZoomFactorChanged += (_, _) =>
            core.PostWebMessageAsJson($"{{\"zoom\":{Math.Round(web.ZoomFactor, 2).ToString(CultureInfo.InvariantCulture)}}}");

        core.Navigate($"https://{Host}/index.html");
    }

    // Copy the embedded web files to disk on every launch, so a newer exe always serves its own version.
    static void ExtractWebApp(string dir)
    {
        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.StartsWith("web/")))
        {
            var path = Path.Combine(dir, name["web/".Length..].Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            try
            {
                using var src = asm.GetManifestResourceStream(name)!;
                using var dst = File.Create(path);
                src.CopyTo(dst);
            }
            catch (IOException) { } // another running copy has the file open; its content is the same version
        }
    }

    static void OpenExternal(string uri)
    {
        if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
    }
}
