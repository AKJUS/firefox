/* Copyright (c) 2007-2008 CSIRO
   Copyright (c) 2007-2008 Xiph.Org Foundation
   Written by Jean-Marc Valin */
/*
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
   OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/* This is a simple MDCT implementation that uses a N/4 complex FFT
   to do most of the work. It should be relatively straightforward to
   plug in pretty much and FFT here.

   This replaces the Vorbis FFT (and uses the exact same API), which
   was a bit too messy and that was ending up duplicating code
   (might as well use the same FFT everywhere).

   The algorithm is similar to (and inspired from) Fabrice Bellard's
   MDCT implementation in FFMPEG, but has differences in signs, ordering
   and scaling in many places.
*/

#ifndef SKIP_CONFIG_H
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif
#endif

#include "mdct.h"
#include "kiss_fft.h"
#include "_kiss_fft_guts.h"
#include <math.h>
#include "os_support.h"
#include "mathops.h"
#include "stack_alloc.h"

#if defined(MIPSr1_ASM)
#include "mips/mdct_mipsr1.h"
#endif

#ifndef M_PI
#define M_PI 3.141592653
#endif

#ifdef CUSTOM_MODES

int clt_mdct_init(mdct_lookup *l,int N, int maxshift, int arch)
{
   int i;
   kiss_twiddle_scalar *trig;
   int shift;
   int N2=N>>1;
   l->n = N;
   l->maxshift = maxshift;
   for (i=0;i<=maxshift;i++)
   {
      if (i==0)
         l->kfft[i] = opus_fft_alloc(N>>2>>i, 0, 0, arch);
      else
         l->kfft[i] = opus_fft_alloc_twiddles(N>>2>>i, 0, 0, l->kfft[0], arch);
#ifndef ENABLE_TI_DSPLIB55
      if (l->kfft[i]==NULL)
         return 0;
#endif
   }
   l->trig = trig = (kiss_twiddle_scalar*)opus_alloc((N-(N2>>maxshift))*sizeof(kiss_twiddle_scalar));
   if (l->trig==NULL)
     return 0;
   for (shift=0;shift<=maxshift;shift++)
   {
      /* We have enough points that sine isn't necessary */
#if defined(FIXED_POINT)
#ifndef ENABLE_QEXT
      for (i=0;i<N2;i++)
         trig[i] = TRIG_UPSCALE*celt_cos_norm(DIV32(ADD32(SHL32(EXTEND32(i),17),N2+16384),N));
#else
      for (i=0;i<N2;i++)
         trig[i] = (kiss_twiddle_scalar)MAX32(-2147483647,MIN32(2147483647,floor(.5+2147483648*cos(2*M_PI*(i+.125)/N))));
#endif
#else
      for (i=0;i<N2;i++)
         trig[i] = (kiss_twiddle_scalar)cos(2*PI*(i+.125)/N);
#endif
      trig += N2;
      N2 >>= 1;
      N >>= 1;
   }
   return 1;
}

void clt_mdct_clear(mdct_lookup *l, int arch)
{
   int i;
   for (i=0;i<=l->maxshift;i++)
      opus_fft_free(l->kfft[i], arch);
   opus_free((kiss_twiddle_scalar*)l->trig);
}

#endif /* CUSTOM_MODES */

/* Forward MDCT trashes the input array */
#ifndef OVERRIDE_clt_mdct_forward
void clt_mdct_forward_c(const mdct_lookup *l, kiss_fft_scalar *in, kiss_fft_scalar * OPUS_RESTRICT out,
      const celt_coef *window, int overlap, int shift, int stride, int arch)
{
   int i;
   int N, N2, N4;
   VARDECL(kiss_fft_scalar, f);
   VARDECL(kiss_fft_cpx, f2);
   const kiss_fft_state *st = l->kfft[shift];
   const kiss_twiddle_scalar *trig;
   celt_coef scale;
#ifdef FIXED_POINT
   /* Allows us to scale with MULT16_32_Q16(), which is faster than
      MULT16_32_Q15() on ARM. */
   int scale_shift = st->scale_shift-1;
   int headroom;
#endif
   SAVE_STACK;
   (void)arch;
   scale = st->scale;

   N = l->n;
   trig = l->trig;
   for (i=0;i<shift;i++)
   {
      N >>= 1;
      trig += N;
   }
   N2 = N>>1;
   N4 = N>>2;

   ALLOC(f, N2, kiss_fft_scalar);
   ALLOC(f2, N4, kiss_fft_cpx);

   /* Consider the input to be composed of four blocks: [a, b, c, d] */
   /* Window, shuffle, fold */
   {
      /* Temp pointers to make it really clear to the compiler what we're doing */
      const kiss_fft_scalar * OPUS_RESTRICT xp1 = in+(overlap>>1);
      const kiss_fft_scalar * OPUS_RESTRICT xp2 = in+N2-1+(overlap>>1);
      kiss_fft_scalar * OPUS_RESTRICT yp = f;
      const celt_coef * OPUS_RESTRICT wp1 = window+(overlap>>1);
      const celt_coef * OPUS_RESTRICT wp2 = window+(overlap>>1)-1;
      for(i=0;i<((overlap+3)>>2);i++)
      {
         /* Real part arranged as -d-cR, Imag part arranged as -b+aR*/
         *yp++ = S_MUL(xp1[N2], *wp2) + S_MUL(*xp2, *wp1);
         *yp++ = S_MUL(*xp1, *wp1)    - S_MUL(xp2[-N2], *wp2);
         xp1+=2;
         xp2-=2;
         wp1+=2;
         wp2-=2;
      }
      wp1 = window;
      wp2 = window+overlap-1;
      for(;i<N4-((overlap+3)>>2);i++)
      {
         /* Real part arranged as a-bR, Imag part arranged as -c-dR */
         *yp++ = *xp2;
         *yp++ = *xp1;
         xp1+=2;
         xp2-=2;
      }
      for(;i<N4;i++)
      {
         /* Real part arranged as a-bR, Imag part arranged as -c-dR */
         *yp++ =  -S_MUL(xp1[-N2], *wp1) + S_MUL(*xp2, *wp2);
         *yp++ = S_MUL(*xp1, *wp2)     + S_MUL(xp2[N2], *wp1);
         xp1+=2;
         xp2-=2;
         wp1+=2;
         wp2-=2;
      }
   }
   /* Pre-rotation */
   {
      kiss_fft_scalar * OPUS_RESTRICT yp = f;
      const kiss_twiddle_scalar *t = &trig[0];
#ifdef FIXED_POINT
      opus_val32 maxval=1;
#endif
      for(i=0;i<N4;i++)
      {
         kiss_fft_cpx yc;
         kiss_twiddle_scalar t0, t1;
         kiss_fft_scalar re, im, yr, yi;
         t0 = t[i];
         t1 = t[N4+i];
         re = *yp++;
         im = *yp++;
         yr = S_MUL(re,t0)  -  S_MUL(im,t1);
         yi = S_MUL(im,t0)  +  S_MUL(re,t1);
         /* For QEXT, it's best to scale before the FFT, but otherwise it's best to scale after.
            For floating-point it doesn't matter. */
#ifdef ENABLE_QEXT
         yc.r = yr;
         yc.i = yi;
#else
         yc.r = S_MUL2(yr, scale);
         yc.i = S_MUL2(yi, scale);
#endif
#ifdef FIXED_POINT
         maxval = MAX32(maxval, MAX32(ABS32(yc.r), ABS32(yc.i)));
#endif
         f2[st->bitrev[i]] = yc;
      }
#ifdef FIXED_POINT
      headroom = IMAX(0, IMIN(scale_shift, 28-celt_ilog2(maxval)));
#endif
   }

   /* N/4 complex FFT, does not downscale anymore */
   opus_fft_impl(st, f2 ARG_FIXED(scale_shift-headroom));

   /* Post-rotate */
   {
      /* Temp pointers to make it really clear to the compiler what we're doing */
      const kiss_fft_cpx * OPUS_RESTRICT fp = f2;
      kiss_fft_scalar * OPUS_RESTRICT yp1 = out;
      kiss_fft_scalar * OPUS_RESTRICT yp2 = out+stride*(N2-1);
      const kiss_twiddle_scalar *t = &trig[0];
      /* Temp pointers to make it really clear to the compiler what we're doing */
      for(i=0;i<N4;i++)
      {
         kiss_fft_scalar yr, yi;
         kiss_fft_scalar t0, t1;
#ifdef ENABLE_QEXT
         t0 = S_MUL2(t[i], scale);
         t1 = S_MUL2(t[N4+i], scale);
#else
         t0 = t[i];
         t1 = t[N4+i];
#endif
         yr = PSHR32(S_MUL(fp->i,t1) - S_MUL(fp->r,t0), headroom);
         yi = PSHR32(S_MUL(fp->r,t1) + S_MUL(fp->i,t0), headroom);
         *yp1 = yr;
         *yp2 = yi;
         fp++;
         yp1 += 2*stride;
         yp2 -= 2*stride;
      }
   }
   RESTORE_STACK;
}
#endif /* OVERRIDE_clt_mdct_forward */

#ifndef OVERRIDE_clt_mdct_backward
void clt_mdct_backward_c(const mdct_lookup *l, kiss_fft_scalar *in, kiss_fft_scalar * OPUS_RESTRICT out,
      const celt_coef * OPUS_RESTRICT window, int overlap, int shift, int stride, int arch)
{
   int i;
   int N, N2, N4;
   const kiss_twiddle_scalar *trig;
#ifdef FIXED_POINT
   int pre_shift, post_shift, fft_shift;
#endif
   (void) arch;

   N = l->n;
   trig = l->trig;
   for (i=0;i<shift;i++)
   {
      N >>= 1;
      trig += N;
   }
   N2 = N>>1;
   N4 = N>>2;

#ifdef FIXED_POINT
   {
      opus_val32 sumval=N2;
      opus_val32 maxval=0;
      for (i=0;i<N2;i++) {
         maxval = MAX32(maxval, ABS32(in[i*stride]));
         sumval = ADD32_ovflw(sumval, ABS32(SHR32(in[i*stride],11)));
      }
      pre_shift = IMAX(0, 29-celt_zlog2(1+maxval));
      /* Worst-case where all the energy goes to a single sample. */
      post_shift = IMAX(0, 19-celt_ilog2(ABS32(sumval)));
      post_shift = IMIN(post_shift, pre_shift);
      fft_shift = pre_shift - post_shift;
   }
#endif
   /* Pre-rotate */
   {
      /* Temp pointers to make it really clear to the compiler what we're doing */
      const kiss_fft_scalar * OPUS_RESTRICT xp1 = in;
      const kiss_fft_scalar * OPUS_RESTRICT xp2 = in+stride*(N2-1);
      kiss_fft_scalar * OPUS_RESTRICT yp = out+(overlap>>1);
      const kiss_twiddle_scalar * OPUS_RESTRICT t = &trig[0];
      const opus_int16 * OPUS_RESTRICT bitrev = l->kfft[shift]->bitrev;
      for(i=0;i<N4;i++)
      {
         int rev;
         kiss_fft_scalar yr, yi;
         opus_val32 x1, x2;
         rev = *bitrev++;
         x1 = SHL32_ovflw(*xp1, pre_shift);
         x2 = SHL32_ovflw(*xp2, pre_shift);
         yr = ADD32_ovflw(S_MUL(x2, t[i]), S_MUL(x1, t[N4+i]));
         yi = SUB32_ovflw(S_MUL(x1, t[i]), S_MUL(x2, t[N4+i]));
         /* We swap real and imag because we use an FFT instead of an IFFT. */
         yp[2*rev+1] = yr;
         yp[2*rev] = yi;
         /* Storing the pre-rotation directly in the bitrev order. */
         xp1+=2*stride;
         xp2-=2*stride;
      }
   }

   opus_fft_impl(l->kfft[shift], (kiss_fft_cpx*)(out+(overlap>>1)) ARG_FIXED(fft_shift));

   /* Post-rotate and de-shuffle from both ends of the buffer at once to make
      it in-place. */
   {
      kiss_fft_scalar * yp0 = out+(overlap>>1);
      kiss_fft_scalar * yp1 = out+(overlap>>1)+N2-2;
      const kiss_twiddle_scalar *t = &trig[0];
      /* Loop to (N4+1)>>1 to handle odd N4. When N4 is odd, the
         middle pair will be computed twice. */
      for(i=0;i<(N4+1)>>1;i++)
      {
         kiss_fft_scalar re, im, yr, yi;
         kiss_twiddle_scalar t0, t1;
         /* We swap real and imag because we're using an FFT instead of an IFFT. */
         re = yp0[1];
         im = yp0[0];
         t0 = t[i];
         t1 = t[N4+i];
         /* We'd scale up by 2 here, but instead it's done when mixing the windows */
         yr = PSHR32_ovflw(ADD32_ovflw(S_MUL(re,t0), S_MUL(im,t1)), post_shift);
         yi = PSHR32_ovflw(SUB32_ovflw(S_MUL(re,t1), S_MUL(im,t0)), post_shift);
         /* We swap real and imag because we're using an FFT instead of an IFFT. */
         re = yp1[1];
         im = yp1[0];
         yp0[0] = yr;
         yp1[1] = yi;

         t0 = t[(N4-i-1)];
         t1 = t[(N2-i-1)];
         /* We'd scale up by 2 here, but instead it's done when mixing the windows */
         yr = PSHR32_ovflw(ADD32_ovflw(S_MUL(re,t0), S_MUL(im,t1)), post_shift);
         yi = PSHR32_ovflw(SUB32_ovflw(S_MUL(re,t1), S_MUL(im,t0)), post_shift);
         yp1[0] = yr;
         yp0[1] = yi;
         yp0 += 2;
         yp1 -= 2;
      }
   }

   /* Mirror on both sides for TDAC */
   {
      kiss_fft_scalar * OPUS_RESTRICT xp1 = out+overlap-1;
      kiss_fft_scalar * OPUS_RESTRICT yp1 = out;
      const celt_coef * OPUS_RESTRICT wp1 = window;
      const celt_coef * OPUS_RESTRICT wp2 = window+overlap-1;

      for(i = 0; i < overlap/2; i++)
      {
         kiss_fft_scalar x1, x2;
         x1 = *xp1;
         x2 = *yp1;
         *yp1++ = SUB32_ovflw(S_MUL(x2, *wp2), S_MUL(x1, *wp1));
         *xp1-- = ADD32_ovflw(S_MUL(x2, *wp1), S_MUL(x1, *wp2));
         wp1++;
         wp2--;
      }
   }
}
#endif /* OVERRIDE_clt_mdct_backward */
