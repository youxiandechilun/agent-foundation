using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;

public static class FoundationDesktop {
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT bounds);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
  public static string Title(IntPtr window) { var text=new StringBuilder(1024);GetWindowText(window,text,1024);return text.ToString(); }
  public static IntPtr Target(string windowId, int processId) {
    var window=new IntPtr(Int64.Parse(windowId));uint actual;
    if (!IsWindow(window) || GetWindowThreadProcessId(window,out actual)==0 || actual!=(uint)processId) throw new Exception("Target window is stale or belongs to another process");
    if (GetAncestor(window,2)!=window) throw new Exception("Target must be a top-level window");
    return window;
  }
  public static Dictionary<string,object> Window(IntPtr window) {
    uint process;GetWindowThreadProcessId(window,out process);RECT r;GetWindowRect(window,out r);
    return new Dictionary<string,object>{{"windowId",window.ToInt64().ToString()},{"processId",process},{"title",Title(window)},{"left",r.Left},{"top",r.Top},{"width",r.Right-r.Left},{"height",r.Bottom-r.Top},{"foreground",window==GetForegroundWindow()}};
  }
  public static object[] Windows(int limit, int[] processes) {
    var list=new List<object>();
    EnumWindows(delegate(IntPtr w, IntPtr unused){
      if(list.Count>=limit)return false;uint p;GetWindowThreadProcessId(w,out p);
      if(IsWindowVisible(w) && Title(w).Length>0 && (processes.Length==0 || Array.IndexOf(processes,(int)p)>=0)) list.Add(Window(w));
      return true;
    },IntPtr.Zero);return list.ToArray();
  }
  public static string ElementId(AutomationElement element) { return "uia:"+String.Join(".",element.GetRuntimeId()); }
  static IEnumerable<AutomationElement> Walk(IntPtr window,int max,int depth) {
    var queue=new Queue<KeyValuePair<AutomationElement,int>>();queue.Enqueue(new KeyValuePair<AutomationElement,int>(AutomationElement.FromHandle(window),0));
    int count=0;
    while(queue.Count>0 && count<max) {
      var item=queue.Dequeue();yield return item.Key;count++;
      if(item.Value>=depth)continue;
      var child=TreeWalker.ControlViewWalker.GetFirstChild(item.Key);
      while(child!=null && queue.Count+count<max) {queue.Enqueue(new KeyValuePair<AutomationElement,int>(child,item.Value+1));child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
    }
  }
  public static object[] Tree(IntPtr window,int max,int depth) {
    var output=new List<object>();
    foreach(var e in Walk(window,max,depth)) {
      try {
        var c=e.Current;var b=c.BoundingRectangle;object pattern;var patterns=new List<string>();
        if(e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))patterns.Add("value");
        if(e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))patterns.Add("invoke");
        if(e.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))patterns.Add("toggle");
        if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))patterns.Add("select");
        if(e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))patterns.Add("expand");
        string value=null;
        if(!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {value=((ValuePattern)pattern).Current.Value;if(value!=null && value.Length>2000)value=value.Substring(0,2000);}
        output.Add(new Dictionary<string,object>{{"elementId",ElementId(e)},{"automationId",c.AutomationId},{"name",c.Name.Length>1000?c.Name.Substring(0,1000):c.Name},{"controlType",c.ControlType.ProgrammaticName},{"enabled",c.IsEnabled},{"offscreen",c.IsOffscreen},{"password",c.IsPassword},{"value",value},{"patterns",patterns.ToArray()},{"bounds",new Dictionary<string,object>{{"x",b.IsEmpty?0:b.X},{"y",b.IsEmpty?0:b.Y},{"width",b.IsEmpty?0:b.Width},{"height",b.IsEmpty?0:b.Height}}}});
      } catch(ElementNotAvailableException) { }
    }
    return output.ToArray();
  }
  static AutomationElement Element(IntPtr window,string reference,int max,int depth) {
    foreach(var e in Walk(window,max,depth)) if(ElementId(e)==reference)return e;
    throw new Exception("Accessibility reference is stale or outside the bounded window tree");
  }
  public static void Pattern(IntPtr window,string reference,string action,string text,int max,int depth) {
    var e=Element(window,reference,max,depth);object pattern;
    if(!e.Current.IsEnabled)throw new Exception("Accessibility element is disabled");
    if(action=="set_value") {
      if(!e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))throw new Exception("Value pattern unavailable");
      var value=(ValuePattern)pattern;if(value.Current.IsReadOnly)throw new Exception("Element is read-only");value.SetValue(text);return;
    }
    if(action=="invoke" && e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)){((InvokePattern)pattern).Invoke();return;}
    if(action=="toggle" && e.TryGetCurrentPattern(TogglePattern.Pattern,out pattern)){((TogglePattern)pattern).Toggle();return;}
    if(action=="select" && e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern)){((SelectionItemPattern)pattern).Select();return;}
    if((action=="expand" || action=="collapse") && e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)) {
      if(action=="expand")((ExpandCollapsePattern)pattern).Expand();else((ExpandCollapsePattern)pattern).Collapse();return;
    }
    throw new Exception("Requested accessibility pattern is unavailable");
  }
  public static void Capture(IntPtr window,string output,int maxPixels) {
    RECT r;
    if(window==IntPtr.Zero) {var s=SystemInformation.VirtualScreen;r=new RECT{Left=s.Left,Top=s.Top,Right=s.Right,Bottom=s.Bottom};}
    else if(!GetWindowRect(window,out r))throw new Exception("Cannot read target bounds");
    int width=r.Right-r.Left,height=r.Bottom-r.Top;
    if(width<1 || height<1 || (long)width*height>maxPixels)throw new Exception("Capture dimensions exceed pixel limit");
    using(var bitmap=new Bitmap(width,height)) using(var g=Graphics.FromImage(bitmap)) {
      if(window==IntPtr.Zero)g.CopyFromScreen(r.Left,r.Top,0,0,bitmap.Size);
      else {var dc=g.GetHdc();try{if(!PrintWindow(window,dc,2))throw new Exception("Target window cannot be captured");}finally{g.ReleaseHdc(dc);}}
      bitmap.Save(output,ImageFormat.Png);
    }
  }
  static void Foreground(IntPtr window) {if(window!=IntPtr.Zero && GetForegroundWindow()!=window)throw new Exception("Target window is not foreground; focus it explicitly before pointer or keyboard input");}
  public static void Focus(IntPtr window) {
    SetForegroundWindow(window);
    // Windows may acknowledge the request before activating the target thread.
    // Wait only for this explicit target; never inject input to obtain focus.
    var deadline=DateTime.UtcNow.AddMilliseconds(750);
    while(GetForegroundWindow()!=window && DateTime.UtcNow<deadline) System.Threading.Thread.Sleep(10);
    if(GetForegroundWindow()!=window)throw new Exception("Windows denied foreground focus");
  }
  static INPUT Mouse(uint flags,uint data,int x,int y) {var input=new INPUT{type=0};input.u.mi=new MOUSEINPUT{dwFlags=flags,mouseData=data,dx=x,dy=y};return input;}
  static INPUT PointInput(IntPtr window,int x,int y) {
    if(window!=IntPtr.Zero) {
      RECT r;GetWindowRect(window,out r);
      if(x<0 || y<0 || x>=r.Right-r.Left || y>=r.Bottom-r.Top)throw new Exception("Pointer coordinate is outside target window");
      x+=r.Left;y+=r.Top;
      var hit=WindowFromPoint(new POINT{X=x,Y=y});
      if(GetAncestor(hit,2)!=window)throw new Exception("Target coordinate is covered by another window");
    }
    var s=SystemInformation.VirtualScreen;
    if(x<s.Left || y<s.Top || x>=s.Right || y>=s.Bottom)throw new Exception("Pointer coordinate is outside desktop");
    return Mouse(0x8000|0x4000|1,0,(int)Math.Round((x-s.Left)*65535.0/Math.Max(1,s.Width-1)),(int)Math.Round((y-s.Top)*65535.0/Math.Max(1,s.Height-1)));
  }
  static void Send(IntPtr window,INPUT[] input) {Foreground(window);if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length)throw new Exception("SendInput failed or was blocked by Windows integrity policy");}
  public static void Pointer(IntPtr window,string action,int x,int y,int toX,int toY,string button,int delta) {
    Foreground(window);uint down=button=="right"?8u:2u,up=button=="right"?16u:4u;
    if(action=="move")Send(window,new[]{PointInput(window,x,y)});
    else if(action=="click")Send(window,new[]{PointInput(window,x,y),Mouse(down,0,0,0),Mouse(up,0,0,0)});
    else if(action=="drag")Send(window,new[]{PointInput(window,x,y),Mouse(down,0,0,0),PointInput(window,toX,toY),Mouse(up,0,0,0)});
    else if(action=="scroll")Send(window,new[]{Mouse(2048,unchecked((uint)delta),0,0)});
  }
  static INPUT Key(ushort key,bool up) {var input=new INPUT{type=1};input.u.ki=new KEYBDINPUT{key=key,flags=up?2u:0u};return input;}
  public static void Keys(IntPtr window,string keys) {
    var names=new Dictionary<string,ushort>{{"ENTER",13},{"TAB",9},{"ESCAPE",27},{"BACKSPACE",8},{"DELETE",46},{"SPACE",32},{"LEFT",37},{"UP",38},{"RIGHT",39},{"DOWN",40},{"HOME",36},{"END",35},{"PAGEUP",33},{"PAGEDOWN",34},{"CTRL",17},{"ALT",18},{"SHIFT",16},{"META",91}};
    var pressed=new List<ushort>();foreach(var name in keys.ToUpperInvariant().Split('+')) {ushort key;if(!names.TryGetValue(name,out key)){if(name.Length==1 && Char.IsLetterOrDigit(name[0]) && name[0]<128)key=name[0];else throw new Exception("Unsupported key");}pressed.Add(key);}
    var input=new List<INPUT>();foreach(var key in pressed)input.Add(Key(key,false));pressed.Reverse();foreach(var key in pressed)input.Add(Key(key,true));Send(window,input.ToArray());
  }
  public static void Text(IntPtr window,string text) {foreach(char c in text){var a=new INPUT{type=1};a.u.ki=new KEYBDINPUT{scan=c,flags=4};var b=a;b.u.ki.flags=6;Send(window,new[]{a,b});}}
}
