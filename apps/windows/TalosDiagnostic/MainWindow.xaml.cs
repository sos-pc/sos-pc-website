using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Navigation;

namespace TalosDiagnostic
{
    public partial class MainWindow : Window
    {
        readonly LaunchOptions options;
        readonly List<(TextBlock Glyph, TextBlock Label)> stepRows = new List<(TextBlock, TextBlock)>();
        CancellationTokenSource cancellation;
        Dictionary<string, object> report;
        string token;

        internal MainWindow(LaunchOptions options)
        {
            this.options = options;
            InitializeComponent();
            VersionRun.Text = "· v" + AppInfo.Version;
            BuildStepList();

            // Launched from talos-int.com (talos-diag: link): the visitor already
            // chose to run the diagnostic on the site, start right away.
            if (options.FromProtocol) Loaded += (s, e) => StartScan();
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            UseDarkTitleBar();
        }

        // ── Scan flow ───────────────────────────────────────────────────────

        async void StartScan()
        {
            ShowPanel(ProgressPanel);
            ResetSteps();
            CancelButton.IsEnabled = true;
            cancellation = new CancellationTokenSource();
            var progress = new Progress<int>(OnStepStarted);

            try
            {
                var ct = cancellation.Token;
                report = await Task.Run(() => new Collector().Run(progress, ct), ct);
            }
            catch (OperationCanceledException)
            {
                ShowPanel(IntroPanel);
                return;
            }
            catch (Exception ex)
            {
                ShowError("Analyse interrompue", "Une erreur inattendue a arrêté l'analyse : " + ex.Message, canRetry: false);
                return;
            }

            await SendReport();
        }

        async Task SendReport()
        {
            ShowPanel(ProgressPanel);
            CancelButton.IsEnabled = false;
            ProgressText.Text = "Envoi du rapport à Talos Int.…";

            try
            {
                token ??= ReportClient.NewToken();
                await ReportClient.SendAsync(options.Origin, token, report, CancellationToken.None);
            }
            catch (Exception ex)
            {
                ShowError("Envoi impossible",
                    "Le rapport n'a pas pu être envoyé. Vérifiez votre connexion internet puis réessayez.\n(" + ex.Message + ")",
                    canRetry: true);
                return;
            }

            ShowPanel(DonePanel);
            if (options.NoBrowser)
                DoneText.Text = "Rapport envoyé. Résultats : " + ReportClient.ResultsUrl(options.Origin, token);
            else
                OpenResults();
        }

        void OnStepStarted(int index)
        {
            for (var i = 0; i < stepRows.Count; i++)
            {
                var (glyph, label) = stepRows[i];
                if (i < index) SetStep(glyph, label, "✓", "AccentBrush", "TextBrush", FontWeights.Normal);
                else if (i == index) SetStep(glyph, label, "›", "AccentBrush", "TextBrush", FontWeights.SemiBold);
                else SetStep(glyph, label, "·", "DimBrush", "DimBrush", FontWeights.Normal);
            }
            Progress.Value = index;
            ProgressText.Text = index < Collector.Steps.Length
                ? "Analyse : " + Collector.Steps[index] + "…"
                : "Analyse terminée.";
        }

        void OpenResults()
        {
            try
            {
                Process.Start(new ProcessStartInfo(ReportClient.ResultsUrl(options.Origin, token)) { UseShellExecute = true });
            }
            catch
            {
                DoneText.Text = "Votre navigateur ne s'est pas ouvert. Rendez-vous sur talos-int.com depuis le bouton ci-dessous.";
            }
        }

        // ── UI helpers ──────────────────────────────────────────────────────

        void BuildStepList()
        {
            foreach (var step in Collector.Steps)
            {
                var row = new DockPanel { Margin = new Thickness(0, 2, 0, 2) };
                var glyph = new TextBlock { Width = 20, FontFamily = (FontFamily)FindResource("MonoFont") };
                var label = new TextBlock { Text = step, FontSize = 13 };
                row.Children.Add(glyph);
                row.Children.Add(label);
                StepList.Children.Add(row);
                stepRows.Add((glyph, label));
            }
            Progress.Maximum = Collector.Steps.Length;
        }

        void ResetSteps() => OnStepStarted(-1);

        void SetStep(TextBlock glyph, TextBlock label, string mark, string glyphBrush, string labelBrush, FontWeight weight)
        {
            glyph.Text = mark;
            glyph.Foreground = (Brush)FindResource(glyphBrush);
            label.Foreground = (Brush)FindResource(labelBrush);
            label.FontWeight = weight;
        }

        void ShowPanel(FrameworkElement panel)
        {
            foreach (var p in new FrameworkElement[] { IntroPanel, ProgressPanel, DonePanel, ErrorPanel })
                p.Visibility = p == panel ? Visibility.Visible : Visibility.Collapsed;
        }

        void ShowError(string title, string message, bool canRetry)
        {
            ErrorTitle.Text = title;
            ErrorText.Text = message;
            RetryButton.Visibility = canRetry ? Visibility.Visible : Visibility.Collapsed;
            ShowPanel(ErrorPanel);
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        void UseDarkTitleBar()
        {
            try
            {
                var hwnd = new WindowInteropHelper(this).Handle;
                var enabled = 1;
                // DWMWA_USE_IMMERSIVE_DARK_MODE: 20 on recent builds, 19 on Windows 10 before 20H1.
                if (DwmSetWindowAttribute(hwnd, 20, ref enabled, sizeof(int)) != 0)
                    DwmSetWindowAttribute(hwnd, 19, ref enabled, sizeof(int));
            }
            catch { }
        }

        // ── Event handlers ──────────────────────────────────────────────────

        void OnStart(object sender, RoutedEventArgs e) => StartScan();

        void OnCancel(object sender, RoutedEventArgs e)
        {
            if (cancellation == null || cancellation.IsCancellationRequested) return;
            cancellation.Cancel();
            CancelButton.IsEnabled = false;
            ProgressText.Text = "Annulation…";
        }

        async void OnRetry(object sender, RoutedEventArgs e) => await SendReport();

        void OnOpenResults(object sender, RoutedEventArgs e) => OpenResults();

        void OnClose(object sender, RoutedEventArgs e) => Close();

        void OnLink(object sender, RequestNavigateEventArgs e)
        {
            try { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); } catch { }
            e.Handled = true;
        }
    }
}
